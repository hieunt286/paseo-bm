import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answersMessageOf } from "../plugin/server/decision-delivery";
import {
  answerEffect,
  arbitrationEffect,
  changeEffect,
  citedAnswerEffect,
  commandDeliveryEffect,
  deliveryEffect,
  grantEffect,
  incidentActionEffect,
  missionCardEffect,
  nothingWas,
  nothingWasSentence,
  recommendationEffect,
} from "../plugin/server/effects";
import { standingArbitrationText } from "../plugin/server/governor-tools";
import { answerNoticeOf } from "../plugin/server/orchestrator-decisions";
import { applyPreparedChange } from "../plugin/server/prepared-changes";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { answerDecision, type Decision, type DecisionDelivery } from "../plugin/shared/decisions";
import { DECISION_WS, makeDecision } from "./helpers/decisions";

/**
 * Effects stated by what was done (delivery line design §7.3; ADR-035
 * decision 6; REQ-213 d; WP-6.6).
 *
 * 1. **The guard.** The modules §7.3 names are parsed with the TypeScript
 *    compiler (comments never count) and every string or template literal
 *    that reads as a sentence is checked: none may speak of a grant, of
 *    something applied, or say "nothing was" — those come from
 *    `server/effects.ts`. Daemon log lines (`[paseo-bm] …`) are not told to
 *    an agent or the owner and are left out. Tool faces that describe a tool
 *    before it runs are allowed by name, each with its reason.
 * 2. **The scan can fail**: a planted source that builds such a sentence
 *    fires, and so does `effects.ts` itself.
 * 3. **Each function** says what its record holds, and nothing when nothing
 *    was done — a precedent written inert, a delivery held, an arbitration
 *    repeated included — and the converted sites say the same.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../plugin/", import.meta.url));

/** The modules of §7.3 that state effects; their sentences come from `effects.ts`. */
const GUARDED_MODULES = [
  "server/mission-tools.ts",
  "server/decision-delivery.ts",
  "shared/bm-tools.ts",
  "server/orchestrator-decisions.ts",
  "server/orchestrator-decide-tools.ts",
  "server/governor-tools.ts",
  "server/decision-rpc.ts",
  "server/command-authority.ts",
  "server/prepared-changes.ts",
] as const;

/** What an effect sentence says. */
const EFFECT_WORDS: readonly RegExp[] = [/\bgrant(?:s|ed)?\b/i, /\bapplied\b/i, /\bnothing was\b/i];

/**
 * Literals that are not effect statements, by file and opening words. Tool
 * faces (`shared/bm-tools.ts`, which cannot import a server module) describe
 * what a tool does before it is called; the sentence a call returns comes
 * from `effects.ts`.
 */
const ALLOWED: ReadonlyArray<{ file: string; startsWith: string; why: string }> = [
  { file: "shared/bm-tools.ts", startsWith: "The owner's decisions as the plugin stores them:", why: "bm_decisions' face names the stored grant field it returns" },
  { file: "shared/bm-tools.ts", startsWith: "Put a decision to the owner", why: "bm_ask_owner's face: options' effects are information, no answer grants them" },
  { file: "shared/bm-tools.ts", startsWith: "Arguments are JSON:", why: "the faces' common suffix on how a refused call is fixed" },
  { file: "shared/bm-tools.ts", startsWith: "Change your mission.", why: "bm_mission_update's face names its `applied` result field" },
  { file: "shared/bm-tools.ts", startsWith: "Answer your Workers' open questions", why: "bm_answer_worker's face: the Main's answer carries no grant (answerDecision)" },
];

interface Sentence {
  file: string;
  line: number;
  text: string;
}

/** Every literal of `source` that reads as a sentence (has a space), templates joined at their holes, log lines left out. */
function sentencesOf(file: string, source: string): Sentence[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Sentence[] = [];
  const add = (node: ts.Node, text: string): void => {
    if (!/\s/.test(text) || text.startsWith("[paseo-bm]")) return;
    out.push({ file, line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    if (ts.isTemplateExpression(node)) {
      add(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("${…}"));
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return out;
}

/** The sentences of `file` that state an effect and are not allowed. */
function effectSentencesOf(file: string, source: string): Sentence[] {
  return sentencesOf(file, source).filter(
    (sentence) => EFFECT_WORDS.some((word) => word.test(sentence.text)) && !ALLOWED.some((allowed) => allowed.file === file && sentence.text.startsWith(allowed.startsWith)),
  );
}

describe("the guard: the modules of §7.3 build no effect sentence outside effects.ts", () => {
  it.each(GUARDED_MODULES)("%s", (file) => {
    const found = effectSentencesOf(file, readFileSync(join(PLUGIN_DIR, file), "utf8"));
    expect(found.map((sentence) => `${sentence.file}:${sentence.line}: ${sentence.text.slice(0, 160)}`)).toEqual([]);
  });

  it("every allowed literal still exists, so the list never outlives its reason", () => {
    for (const allowed of ALLOWED) {
      const sentences = sentencesOf(allowed.file, readFileSync(join(PLUGIN_DIR, allowed.file), "utf8"));
      expect(sentences.some((sentence) => sentence.text.startsWith(allowed.startsWith)), allowed.startsWith).toBe(true);
    }
  });

  it("fires on a planted source, on a template and a plain string, and on effects.ts itself; comments and logs never count", () => {
    const planted = [
      "// it grants nothing: a comment is not a sentence",
      "const a = `delivered to the Worker; it grants nothing`;",
      'const b = "change: applied by the plugin";',
      "const c = `${x}; nothing was sent`;",
      'const d = "[paseo-bm] the change was applied";',
      'const e = "no-grant";',
    ].join("\n");
    expect(effectSentencesOf("planted.ts", planted).map((sentence) => sentence.line)).toEqual([2, 3, 4]);
    expect(effectSentencesOf("server/effects.ts", readFileSync(join(PLUGIN_DIR, "server/effects.ts"), "utf8")).length).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// The functions, from their records.
// ---------------------------------------------------------------------------

const AT = "2026-10-20T10:00:00.000Z";
const delivery = (outcome: DecisionDelivery["outcome"]): DecisionDelivery => ({ to: "agent-worker", kind: "answers:req", at: AT, outcome });

function answered(decision: Decision, input: Parameters<typeof answerDecision>[1]): Decision {
  const result = answerDecision(decision, input);
  if (!result.ok) throw new Error(result.message);
  return result.decision;
}

const optionC = () => makeDecision({ subject: "push-backends", class: "scope" });
const mainAnswer = () => answered(optionC(), { by: "main", via: "main", optionKey: "a", reason: "The plan says so.", at: AT });

describe("answers and grants", () => {
  it("grantEffect: nothing on a null grant; the effects and hour of a written one; its use once spent", () => {
    expect(grantEffect(mainAnswer())).toEqual({ applied: null, sentence: "it grants nothing" });
    const owner = answered(optionC(), { via: "inbox", optionKey: "a", at: AT });
    expect(owner.grant).not.toBeNull();
    expect(grantEffect(owner)).toEqual({
      applied: { kind: "grant", decisionId: owner.id, effects: ["push"], expiresAt: owner.grant!.expiresAt, usedAt: null },
      sentence: `it grants push for one use until ${owner.grant!.expiresAt}`,
    });
    const used = { ...owner, grant: { ...owner.grant!, usedAt: AT } };
    expect(grantEffect(used).sentence).toBe(`its grant of push was used at ${AT}`);
  });

  it("answerEffect: the Main's answer as its delivery and grant were recorded — delivered, queued, failed, not yet", () => {
    const as = "your answer, not the owner's";
    const base = mainAnswer();
    expect(answerEffect({ ...base, delivery: delivery("sent") }, as)).toEqual({
      applied: { kind: "answer", decisionId: base.id, by: "main", optionKey: "a" },
      sentence: "delivered to the Worker as your answer, not the owner's; it grants nothing",
    });
    expect(answerEffect({ ...base, delivery: delivery("queued") }, as).sentence).toBe("queued for the Worker as your answer, not the owner's: it gets it when its current turn ends; it grants nothing");
    expect(answerEffect({ ...base, delivery: delivery("failed") }, as).sentence).toBe(
      "recorded as your answer, not the owner's, but not delivered to the Worker (the owner sees that in the Inbox); it grants nothing",
    );
    expect(answerEffect(base, as).sentence).toBe("recorded as your answer, not the owner's; not delivered to the Worker yet; it grants nothing");
    expect(answerEffect({ ...base, delivery: delivery("held") }, as).sentence).toBe(
      "recorded as your answer, not the owner's; held for the Worker: it gets it with what it waits on (delivery line design §6.4); it grants nothing",
    );
    expect(answerEffect(optionC(), as)).toEqual({ applied: null, sentence: "nothing was answered" });
  });

  it("citedAnswerEffect and answersMessageOf: the Main's answer cites the grant it carries; the owner's own answer is not cited", () => {
    expect(citedAnswerEffect(mainAnswer())?.sentence).toBe("Q1 was answered by your mission's Main, not the owner (The plan says so.): it grants nothing beyond your rules.");
    // Should a stored Main answer ever carry a grant, the Worker reads that grant, not "nothing".
    const granted = { ...mainAnswer(), grant: { effects: ["push" as const], expiresAt: AT, usedAt: null } };
    expect(citedAnswerEffect(granted)?.sentence).toBe(`Q1 was answered by your mission's Main, not the owner (The plan says so.): it grants push for one use until ${AT}.`);
    expect(answersMessageOf("req", [mainAnswer()])).toContain("Q1 was answered by your mission's Main, not the owner (The plan says so.): it grants nothing beyond your rules.");
    expect(citedAnswerEffect(answered(optionC(), { via: "inbox", optionKey: "c", at: AT }))).toBeNull();
  });

  it("recommendationEffect: the stored prediction, or nothing", () => {
    const open = optionC();
    expect(recommendationEffect(open)).toEqual({ applied: null, sentence: "nothing was recorded" });
    const predicted = { ...open, prediction: { main: { optionKey: "b", reason: "x", at: AT } } } as Decision;
    expect(recommendationEffect(predicted)).toEqual({ applied: { kind: "recommendation", decisionId: open.id, optionKey: "b" }, sentence: "recorded as your recommendation; the owner decides it" });
  });
});

describe("changes", () => {
  const text = "sets Scope decisions in this project to Shadow";

  it("changeEffect: applied, already so, written but inert, failed — for the agent and for the log", () => {
    expect(changeEffect({ applied: true, wrote: true, text }, { for: "agent" })).toEqual({
      applied: { kind: "change", text, wrote: true },
      sentence: `applied by the plugin — it ${text}; send nothing for it`,
    });
    expect(changeEffect({ applied: true, wrote: false, text }, { for: "agent" }).sentence).toBe(`applied by the plugin — it ${text} (it was so already); send nothing for it`);
    const inert = changeEffect({ applied: true, wrote: true, text, inert: "no precedent answers it" }, { for: "agent" });
    expect(inert.applied).toEqual({ kind: "change", text, wrote: true, inert: "no precedent answers it" });
    expect(inert.sentence).toBe(`written, but it answers nothing (no precedent answers it) — it ${text}; tell the owner, and set nothing yourself`);
    expect(inert.sentence).not.toContain("applied");
    expect(changeEffect({ applied: false, text, reason: "why" }, { for: "agent" })).toEqual({ applied: null, sentence: "not applied (why); nothing was changed — tell the owner, and set nothing yourself" });
    expect(changeEffect({ applied: true, wrote: false, text }, { for: "log", decisionId: "o:x" }).sentence).toBe(`[paseo-bm] decision o:x: the owner's answer found already applied: it ${text}`);
    expect(changeEffect({ applied: false, text, reason: "why" }, { for: "log", decisionId: "o:x" }).sentence).toBe("[paseo-bm] decision o:x: the owner's answer could not apply its change (why); nothing was changed");
  });

  it("answerNoticeOf: the BM-ANSWER's change: line is the change's effect, an inert precedent never called applied", () => {
    const decision = answered(makeDecision({ id: "o:effects-1", askedBy: { role: "orchestrator", agentId: "agent-orchestrator" } }), { via: "inbox", optionKey: "c", at: AT });
    expect(answerNoticeOf(decision, null, { applied: true, wrote: true, text })).toContain(`\nchange: applied by the plugin — it ${text}; send nothing for it\n`);
    const inert = answerNoticeOf(decision, null, { applied: true, wrote: true, text, inert: "no precedent answers it" });
    expect(inert).toContain(`\nchange: written, but it answers nothing (no precedent answers it) — it ${text}; tell the owner, and set nothing yourself\n`);
    expect(answerNoticeOf(decision, "gone")).toContain("\ndelivery: the prepared command was not delivered (gone); nothing was sent\n");
  });

  describe("on a data folder", () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "bm-effects-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("a prepared precedent on a subject no precedent answers is not applied and writes nothing; the notice says so", () => {
      const decision = answered(
        makeDecision({
          id: "o:effects-2",
          askedBy: { role: "orchestrator", agentId: "agent-orchestrator" },
          subject: "advice",
          options: [{ key: "a", label: "Save it", recommended: true, effects: ["none"], action: { kind: "precedent.save", scope: "project", subject: "review-cap", text: "Always more." } }],
        }),
        { via: "inbox", optionKey: "a", at: AT },
      );
      const result = applyPreparedChange(decision, { home: root, now: new Date(AT), log: () => {} });
      expect(result).toMatchObject({ applied: false });
      expect(createPrecedentStore(root).active(new Date(AT), DECISION_WS)).toEqual([]);
      const notice = answerNoticeOf(decision, null, result);
      expect(notice).toMatch(/\nchange: not applied \(.*review-cap.*\); nothing was changed — tell the owner, and set nothing yourself\n/);
      expect(notice).not.toContain("applied by the plugin");
    });

    it("a precedent the write stored is applied as read back from the store", () => {
      const decision = answered(
        makeDecision({
          id: "o:effects-3",
          askedBy: { role: "orchestrator", agentId: "agent-orchestrator" },
          subject: "advice",
          options: [{ key: "a", label: "Save it", recommended: true, effects: ["none"], action: { kind: "precedent.save", scope: "project", subject: "date-format", text: "ISO dates." } }],
        }),
        { via: "inbox", optionKey: "a", at: AT },
      );
      const result = applyPreparedChange(decision, { home: root, now: new Date(AT), log: () => {} });
      expect(result).toMatchObject({ applied: true, wrote: true });
      expect(result).not.toHaveProperty("inert");
      expect(createPrecedentStore(root).active(new Date(AT), DECISION_WS).map((precedent) => precedent.subject)).toEqual(["date-format"]);
    });
  });

  it("missionCardEffect: the Main's line and the journal line, applied or not", () => {
    expect(missionCardEffect("m:x:1", "your card", { ok: true, journal: "name to Pay", main: "name to Pay" })).toEqual({
      applied: { kind: "mission-change", decisionId: "m:x:1" },
      sentence: "The owner applied your card m:x:1: name to Pay.",
      journal: "The owner applied m:x:1: name to Pay.",
    });
    expect(missionCardEffect("m:x:1", "the governor's card", { ok: false, reasons: ["closed", "gone"] })).toEqual({
      applied: null,
      sentence: "The owner chose to apply the governor's card m:x:1, but it could not be applied: closed; gone.",
      journal: "m:x:1 could not be applied: closed; gone",
    });
  });
});

describe("deliveries", () => {
  it("deliveryEffect: delivered, queued (and replaced), held, dropped and failed, nothing sent", () => {
    const what = "the answer";
    expect(deliveryEffect({ what, to: "w1", outcome: "sent" })).toEqual({ applied: { kind: "delivery", to: "w1", outcome: "sent" }, sentence: "the answer was delivered to w1" });
    expect(deliveryEffect({ what, to: "w1", outcome: "queued" }).sentence).toBe("the answer is queued: w1 gets it when its current turn ends");
    expect(deliveryEffect({ what, to: "w1", outcome: "replaced" }).applied).toEqual({ kind: "delivery", to: "w1", outcome: "queued" });
    expect(deliveryEffect({ what, to: "w1", outcome: "held" })).toEqual({ applied: { kind: "delivery", to: "w1", outcome: "held" }, sentence: "the answer is held: w1 gets it once what it waits for is settled" });
    expect(deliveryEffect({ what, outcome: "dropped", why: "gone" })).toEqual({ applied: null, sentence: "the answer was not delivered (gone); nothing was sent" });
    expect(deliveryEffect({ what, outcome: "failed" }).sentence).toBe("the answer was not delivered; nothing was sent");
    expect(deliveryEffect({ what, outcome: null })).toEqual({ applied: null, sentence: "nothing was sent" });
    expect(deliveryEffect({ what, to: "any agent", outcome: null }).sentence).toBe("nothing was sent to any agent");
  });

  it("commandDeliveryEffect and incidentActionEffect: what the decision's delivery records, never what is meant", () => {
    expect(commandDeliveryEffect({ ...delivery("sent"), to: "mgr" }).sentence).toBe("The plugin delivered the option's command to mgr, with the owner's authority.");
    expect(commandDeliveryEffect({ ...delivery("queued"), to: "mgr" }).sentence).toBe("The plugin queued the option's command for mgr, with the owner's authority: it gets it when its current turn ends.");
    expect(commandDeliveryEffect(delivery("failed"))).toEqual({ applied: null, sentence: "The plugin could not deliver the option's command; a BM-ANSWER tells you why." });
    expect(commandDeliveryEffect(null)).toEqual({ applied: null, sentence: "The option's command is not delivered yet; bm_decisions shows its delivery." });
    expect(incidentActionEffect(delivery("sent")).sentence).toBe("The plugin ran the option's action on the incident.");
    expect(incidentActionEffect(delivery("failed")).sentence).toBe("The plugin could not run the option's action; the owner sees that in the Inbox.");
    expect(incidentActionEffect(null)).toEqual({ applied: null, sentence: "The option's action has not run yet; bm_decisions shows its delivery once it has." });
  });

  it("nothingWas: the clause and the sentence of a refusal or a repeat", () => {
    expect(nothingWas("stored")).toBe("nothing was stored");
    expect(nothingWasSentence("read or changed")).toBe("Nothing was read or changed.");
  });
});

describe("arbitrations", () => {
  it("a repeated arbitration applies nothing and names the standing one; a new one names what was recorded", () => {
    const standing = { id: "arb-0123456789", at: "2026-10-09T12:00:00.000Z" };
    const repeat = arbitrationEffect({ standing, area: "src/pay", ownerCode: "PAY" });
    expect(repeat).toEqual({ applied: null, sentence: "Area src/pay was arbitrated as arb-0123456789 on 2026-10-09 (owner: PAY); nothing was sent." });
    expect(standingArbitrationText("src/pay", standing, "PAY")).toBe(repeat.sentence);
    const recorded = arbitrationEffect({
      recorded: { ...standing, decisionId: "m:mis-1:2" },
      area: "src/pay",
      workspaceId: "repo-b",
      ownerCode: "PAY",
      loserCode: "EXP",
      told: ["the Main of PAY is told (command c1)", "the Main of EXP is told (command c2)"],
    });
    expect(recorded).toEqual({
      applied: { kind: "arbitration", arbitrationId: standing.id, at: standing.at },
      sentence:
        "Arbitration arb-0123456789 recorded: src/pay in repo-b belongs to mission PAY; the Main of PAY is told (command c1); the Main of EXP is told (command c2). The owner is asked on card m:mis-1:2 to change mission EXP's goal.",
    });
  });
});
