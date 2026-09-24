import { describe, expect, it } from "vitest";
import { checkBlocks } from "../plugin/shared/bm-format";
import { parseAnswers, parseQuestions } from "../plugin/shared/bm-questions";
import { parseReports, parseReviews } from "../plugin/shared/bm-report";
import { toolNamed, type ToolResult } from "../plugin/shared/bm-tools";
import { summaryOf, toChatCard } from "../plugin/client/chat-cards";
import { blocksCompletion } from "../plugin/server/traces";

/**
 * Every block a tool builds is read back the way the plugin reads it — the
 * format check, the report and review parsers, the question and answer
 * readers, the chat card, the trace's "still waiting" rule — on hundreds of
 * generated inputs (design delta 20260924b-agent-tools, "test every case").
 * Seeded, so a failure replays.
 */

function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "sửa lỗi đăng nhập",
  "Hà Nội đẹp",
  "`npm test`",
  "a; b",
  "(tracked)",
  "step a) then (b",
  "none",
  "Nothing",
  "x — y",
  "50% faster, 2x",
  "path/to/file.ts:12",
  "đ Đ ơ ư",
  "quote \"it\"",
  "trailing.",
  "multi\nline",
  "tab\tseparated",
  "emoji ✅",
  "BM-REPORT inside",
  "Suggestion (not done): already",
];

function generator(seed: number) {
  const random = prng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const count = (max: number) => Math.floor(random() * (max + 1));
  const words = () => Array.from({ length: 1 + count(2) }, () => pick(PIECES)).join(" ");
  const maybe = <T,>(value: () => T): T | undefined => (random() < 0.5 ? value() : undefined);
  const bead = () => `${pick(["bm", "p1", "xs"])}-${pick(["abc", "a1b2", "fix-x"])}${random() < 0.3 ? `.${1 + count(3)}` : ""}`;
  return { random, pick, count, words, maybe, bead };
}

const REQ = "req-20260924T150000Z";
const text = (result: ToolResult) => (result.ok ? result.text : null);

describe("bm_report: what it builds is what every reader reads (500 generated reports)", () => {
  it("round-trips through the check, the parser, the questions reader, the card and the trace", () => {
    let built = 0;
    for (let seed = 1; seed <= 500; seed += 1) {
      const g = generator(seed);
      const phase = g.pick(["received", "beads-done", "blocked", "finished"] as const);
      const level = g.pick(["Small", "Medium", "Large"] as const);
      const changedFrom = g.random() < 0.3 ? g.pick(["Small", "Medium", "Large"].filter((tier) => tier !== level)) : undefined;
      const questions =
        phase === "blocked"
          ? Array.from({ length: 1 + g.count(4) }, (_, index) => {
              const size = 2 + g.count(3);
              const recommended = g.count(size - 1);
              const options = Array.from({ length: size }, (_, position) => ({ text: g.words(), ...(position === recommended ? { recommended: true } : {}) }));
              return { id: `Q${index + 1 + (seed % 7)}`, text: g.words(), options };
            })
          : undefined;
      const input = {
        requestId: REQ,
        phase,
        tier: { level, ...(changedFrom === undefined ? {} : { changedFrom, reason: g.words() }), ...(g.random() < 0.5 ? { note: g.words() } : {}) },
        filesChanged: g.maybe(() => Array.from({ length: g.count(3) }, () => g.words())),
        beadsCreated: g.maybe(() => Array.from({ length: g.count(3) }, g.bead)),
        beadsClosed: g.maybe(() => Array.from({ length: g.count(3) }, g.bead)),
        reviewFindingsOpen: g.maybe(() => Array.from({ length: g.count(2) }, () => ({ batchId: `b${1 + g.count(4)}`, finding: g.words() }))),
        buildAndTests: g.words(),
        skillsUsed: g.maybe(() => Array.from({ length: g.count(2) }, () => g.pick(["feature-workflow", "implementing-beads", "polishing-beads"]))),
        decided: g.maybe(() => Array.from({ length: g.count(3) }, () => ({ choice: g.words(), why: g.words() }))),
        blockers: g.maybe(() => g.words()),
        suggestions: g.maybe(() => Array.from({ length: g.count(3) }, () => g.words())),
        questions,
      };
      const result = toolNamed("bm_report")!.run(input);
      if (!result.ok) {
        // A refusal is allowed only for a value that reads as a template placeholder, and says which.
        expect(result.issues.length, `seed ${seed}`).toBeGreaterThan(0);
        for (const issue of result.issues) expect(issue, `seed ${seed}`).toMatch(/^input[.\w[\]]*: /);
        continue;
      }
      built += 1;
      const block = text(result)!;
      // The plugin's own check.
      expect(checkBlocks(block).flatMap((checked) => checked.issues), `seed ${seed}`).toEqual([]);
      // The parser the Dashboard and the traces use.
      const [report] = parseReports(block, { agentId: "w", at: "" });
      expect(report, `seed ${seed}`).toMatchObject({ requestId: REQ, phase });
      expect(report!.tier, `seed ${seed}`).toBe(level);
      expect(report!.beadsCreated, `seed ${seed}`).toEqual([...new Set(input.beadsCreated ?? [])]);
      expect(report!.beadsClosed, `seed ${seed}`).toEqual([...new Set(input.beadsClosed ?? [])]);
      expect(report!.decided ?? [], `seed ${seed}`).toHaveLength(input.decided?.length ?? 0);
      // What the Worker's own blockers text holds: what waits, then any suggestions it wrote there out of habit.
      const [head = "", ...fromBlockers] = (input.blockers ?? "").replace(/\s*\n\s*/g, " ").split(/suggestion \(not done\):/i);
      const waits = head.replace(/[\s.;,]+$/, "").trim();
      // The readers' rule: a value that opens with "none" waits on nothing; the tool also drops a bare "nothing", "n/a" or "-".
      const ownWaits = waits !== "" && !/^none\b/i.test(waits) && !/^(?:nothing|n\/a|-+)\.?$/i.test(waits);
      // The trace: waiting only on the Worker's own blockers or its questions.
      expect(blocksCompletion(report!.blockers), `seed ${seed}`).toBe(phase === "blocked" || ownWaits);
      // Every suggestion, wherever the Worker wrote it, is one countable item for the Manager.
      const suggestions = [...fromBlockers.map((part) => part.replace(/^[\s.;,]+|[\s.;,]+$/g, "")), ...(input.suggestions ?? []).map((entry) => entry.replace(/^\s*suggestion \(not done\):\s*/i, "").trim())].filter((part) => part !== "");
      expect((block.match(/Suggestion \(not done\):/g) ?? []).length, `seed ${seed}`).toBe(suggestions.length);
      // The questions the card shows.
      const asked = parseQuestions(block);
      if (phase === "blocked") {
        expect(asked?.questions.map((question) => question.id), `seed ${seed}`).toEqual(questions!.map((question) => question.id));
        asked!.questions.forEach((question, index) => {
          expect(question.options, `seed ${seed}`).toHaveLength(questions![index]!.options.length);
          expect(question.options.filter((option) => option.recommended), `seed ${seed}`).toHaveLength(1);
        });
      } else {
        expect(asked?.questions ?? [], `seed ${seed}`).toEqual([]);
      }
      // The card in the Manager's chat.
      const card = toChatCard({ type: "user_message", text: block }, "complete")!;
      expect(card, `seed ${seed}`).toMatchObject({ type: "report", phase, formatIssues: [] });
      expect(card.questions, `seed ${seed}`).toHaveLength(questions?.length ?? 0);
      expect(/waiting on/.test(summaryOf(card)), `seed ${seed}`).toBe(phase !== "blocked" && ownWaits);
    }
    // The generator must mostly produce buildable reports, or the test proves little.
    expect(built).toBeGreaterThan(400);
  });
});

describe("bm_review: the verdict and the count every reader takes (300 generated reviews)", () => {
  it("round-trips through the check, the review parser and the card", () => {
    let built = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const g = generator(seed * 31);
      const findings = Array.from({ length: g.count(4) }, () => ({
        severity: g.pick(["blocking", "non-blocking"] as const),
        location: g.pick(["src/a.ts:3", "bm-abc", "README § Usage"]),
        reason: g.words(),
        suggestedFix: g.words(),
      }));
      const input = { requestId: REQ, batchId: `b${1 + g.count(5)}`, reviewKind: g.pick(["first", "re-review"]), checked: g.words(), findings, notChecked: g.words() };
      const result = toolNamed("bm_review")!.run(input);
      if (!result.ok) {
        for (const issue of result.issues) expect(issue, `seed ${seed}`).toMatch(/^input[.\w[\]]*: /);
        continue;
      }
      built += 1;
      const block = text(result)!;
      expect(checkBlocks(block).flatMap((checked) => checked.issues), `seed ${seed}`).toEqual([]);
      const blocking = findings.filter((finding) => finding.severity === "blocking").length;
      const [review] = parseReviews(block, { agentId: "r", at: "" });
      expect(review, `seed ${seed}`).toMatchObject({ batchId: input.batchId, verdict: blocking > 0 ? "changes-required" : "pass", blockingCount: blocking });
      const card = toChatCard({ type: "assistant_message", text: block }, "complete")!;
      expect(card, `seed ${seed}`).toMatchObject({ type: "review", verdict: review!.verdict, blocking, formatIssues: [] });
    }
    expect(built).toBeGreaterThan(250);
  });
});

describe("bm_answers: the answers the Worker's ledger reads (300 generated relays)", () => {
  it("round-trips through the check and the answers reader", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const g = generator(seed * 97);
      const answers = Array.from({ length: 1 + g.count(4) }, (_, index) =>
        g.random() < 0.7 ? { id: `Q${index + 1}`, option: g.pick(["a", "b", "c"]), optionText: g.words() } : { id: `Q${index + 1}`, other: g.words() },
      );
      const result = toolNamed("bm_answers")!.run({ requestId: REQ, answers });
      expect(result.ok, `seed ${seed}: ${result.ok ? "" : result.issues.join("; ")}`).toBe(true);
      const block = text(result)!;
      expect(checkBlocks(block).flatMap((checked) => checked.issues), `seed ${seed}`).toEqual([]);
      const read = parseAnswers(`Continue ${REQ}.\n\n${block}`);
      expect(read?.requestId, `seed ${seed}`).toBe(REQ);
      expect(read?.answers.map((answer) => answer.id), `seed ${seed}`).toEqual(answers.map((answer) => answer.id));
      read!.answers.forEach((answer, index) => {
        const given = answers[index]!;
        expect(answer.text.startsWith("option" in given ? `${given.option} — ` : "other — "), `seed ${seed}`).toBe(true);
      });
    }
  });
});
