import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNTIME_FACTS_HEADING } from "../plugin/server/role-extras";
import { BUDGET_NOTICE_MARKER, budgetNotice } from "../plugin/server/review-budget";

/**
 * What the three role files must carry.
 *
 * Two layers, on purpose (design delta 20260917b-simplify-roles §4.6):
 *
 * 1. VERBATIM — only what something outside the file reads: the `BM-REPORT` and
 *    `BM-REVIEW` blocks, the stop line, label and provider names, the budget
 *    numbers. One changed character there breaks the collector, the report
 *    parser or the Dashboard, so those are pinned exactly.
 *
 * 2. BY INTENT — one assertion per rule, matched on a few interchangeable
 *    phrasings over the WHOLE file. Rewording a rule stays green; deleting it
 *    goes red.
 *
 * The suite this replaced pinned nearly every sentence, and its own header
 * warned that this "would make the next simplification just as hard". It did:
 * the owner asked on 2026-09-17 to collapse the case-by-case prohibitions, and
 * every collapse would have turned assertions red for wording reasons alone.
 * So: no assertion for a rule that moves is scoped to a `## ` section, because
 * that delta moves most of `## RULES` down into the steps.
 */
const read = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../plugin/roles/${file}`, import.meta.url)), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

const worker = read("worker.md");
const reviewer = read("reviewer.md");
const manager = read("manager.md");
const W = flat(worker);
const R = flat(reviewer);
const M = flat(manager);

type Pattern = string | RegExp;
const hit = (text: string, p: Pattern) => (typeof p === "string" ? text.includes(p) : p.test(text));

/** The file states this rule, however it is worded: one phrasing is enough. */
function rule(text: string, name: string, ...phrasings: Pattern[]): void {
  expect(phrasings.some((p) => hit(text, p)), `rule missing: ${name}`).toBe(true);
}

/** The file pins this exactly, because something else parses it. */
function verbatim(text: string, ...phrases: string[]): void {
  for (const phrase of phrases) expect(text, phrase).toContain(phrase);
}

/** These appear in this order. Content-anchored, never heading-anchored. */
function order(text: string, label: string, ...steps: string[]): void {
  steps.reduce((from, step) => {
    const at = text.indexOf(step, from);
    expect(at, `${label} → ${step}`).toBeGreaterThanOrEqual(0);
    return at;
  }, 0);
}

/**
 * Every pattern appears within `window` characters of some occurrence of the
 * anchor word. Use it when a rule is an AND of several things said about one
 * subject ("agents: never created, archived or deleted") and a plain
 * alternation would pass on the easiest half alone.
 */
function about(text: string, anchor: string, window: number, ...required: RegExp[]): void {
  const lower = text.toLowerCase();
  const windows: string[] = [];
  for (let at = lower.indexOf(anchor); at !== -1; at = lower.indexOf(anchor, at + 1)) {
    windows.push(text.slice(Math.max(0, at - window), at + window));
  }
  expect(windows.length, `nothing said about: ${anchor}`).toBeGreaterThan(0);
  for (const pattern of required) {
    expect(
      windows.some((w) => pattern.test(w)),
      `about "${anchor}", missing: ${pattern}`,
    ).toBe(true);
  }
}

/** The text between two content markers, for order assertions inside one block. */
function between(text: string, start: string, end?: string): string {
  const from = text.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(from);
  if (!end) return rest;
  const to = rest.indexOf(end);
  return to === -1 ? rest : rest.slice(0, to);
}

/** The lines of the `## RULES` block, up to the next `## ` heading. */
function rulesBlock(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf("## RULES");
  expect(start, "## RULES").toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start, end === -1 ? undefined : end);
}

// The limits themselves are checked against the `## RULES` block, not the whole
// file: b2 review found /revert/ satisfied by "reviewed and reverted on its own"
// in Step 3 and /stage/ by "the stage (`documents`, …)" in the Review section,
// so W2's verb clause could be deleted with the suite still green.
const WR = flat(rulesBlock(worker).join("\n"));
const RR = flat(rulesBlock(reviewer).join("\n"));
const MR = flat(rulesBlock(manager).join("\n"));

describe("all three files", () => {
  // The long versions were 190–520 lines; the owner asked for short ones. On
  // 2026-09-17 worker.md was raised to 270 then 280 for the workflow-skills
  // rules; delta 20260917b-simplify-roles pays both back and puts every file
  // under one limit again.
  // Limits set from measurement after delta 20260917b-simplify-roles, each the
  // measured length plus ten lines of headroom. The 240 that delta proposed for
  // all three was written before the rewrite existed; worker.md landed at 266
  // because the transition table moves content rather than deleting it, and
  // squeezing prose to reach a number invented in advance is the move W4
  // forbids. What actually shrank is the RULES block — see the budget below.
  // Delta 20260917c (owner decision Q16: the ratio of judgement to compliance
  // matters, not the length) measured 361 / 153 / 147 after adding the worked
  // examples, the stage criteria in the Worker's brief, the non-code guidance
  // and the user-facing part of the Manager. Ceilings are those plus ten.
  //
  // manager.md went 158 -> 160 for delta 20260917f, which added two rules that
  // fix a defect the owner hit: `/bm-worker-new` must open NEW work instead of
  // being folded into whatever is running, and a message must never be sent to
  // a Worker that is `running` because it replaces the turn and throws that
  // work away. The raise was the last resort, not the first: the duplicate
  // statement of the turn-replacement hazard was removed from the BM-BUDGET
  // bullet, the two rules were folded into step 2's paragraph, and the block
  // was re-wrapped — after which the text still needed one line more than the
  // old ceiling. Cutting a safeguard to fit a number would be the move W4
  // forbids, in the other direction.
  //
  // manager.md went 160 -> 174 for delta 20260918c-question-cards (owner
  // decision Q46: measured length + 3). With several Workers asking at once the
  // Manager must list the questions per Worker, map the user's `A6 a, B1 b`
  // back to each Worker and send only that Worker's `BM-ANSWERS` block; the
  // `blocked` bullet grew from 4 to 18 lines, 6 of them the block example the
  // Manager copies. Rule 2 and rule 3 were re-wrapped so `## RULES` stayed at
  // 29 lines; the file measured 171. Dropping the example or the "ask back"
  // and "not while running" rules to fit 160 would cut the very safeguards the
  // delta exists for.
  //
  // Delta 20260918d-card-replies rewrote "Talking to the user" (the Manager
  // no longer repeats what a report's card shows) inside the same ceiling:
  // 173 lines, RULES untouched.
  //
  // worker.md 394 -> 397 and manager.md 174 -> 176 for delta
  // 20260918g-agent-conventions (owner decision Q14 a, raised just enough): each
  // file gains one verbatim rule for the plugin's BM-FORMAT notice — the sender
  // of a block that breaks its template must resend the whole corrected block,
  // not take the notice for the user's words or redo work. The rules were
  // appended to an existing paragraph and that paragraph re-wrapped (+3 and +2
  // lines); RULES untouched. reviewer.md took its rule within its ceiling.
  it.each([
    ["worker.md", worker, 397],
    ["reviewer.md", reviewer, 164],
    ["manager.md", manager, 176],
  ])("%s leads with the hard limits and stays under %i lines", (_name, text, limit) => {
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    expect(headings[0]).toBe("## RULES");
    expect(text).toMatch(/NEVER/);
    expect(text.split("\n").length).toBeLessThan(limit);
  });

  it.each([
    ["worker.md", worker],
    ["reviewer.md", reviewer],
    ["manager.md", manager],
  ])("%s has no placeholder left", (_name, text) => {
    expect(text).not.toMatch(/TODO|TBD|\[fill/i);
  });

  it("answers the user in the user's language", () => {
    rule(W, "worker speaks the user's language", "in the user's language");
    rule(M, "manager speaks the user's language", "in the user's language");
  });
});

describe("worker.md — hard limits", () => {
  it("W1 — nothing leaves the workspace without an explicit yes", () => {
    // Negated forms on purpose: a bare /deploy/i would also pass on text that
    // said the opposite (b2 review).
    rule(WR, "no commit, push or pull request", /(no|never)[^.]{0,20}commit|(no|never)[^.]{0,30}push/i);
    rule(WR, "no deploy", /(no|never)[^.]{0,20}deploy/i);
    rule(WR, "no publish", /(no|never)[^.]{0,30}publish/i);
    rule(WR, "no network", /(no|never)[^.]{0,20}network/i);
    rule(WR, "no dependency install", /(no|never)[^.]{0,40}(install|upgrad)[^.]{0,40}dependenc/i);
    rule(WR, "no elevated privileges", /(no|never)[^.]{0,30}(elevated )?privilege/i);
    rule(WR, "no migration on real data", /(no|never)[^.]{0,30}migration on real data/i);
    rule(WR, "no writing outside the workspace", /\b(no|never) (writing|write)s? outside/i);
    rule(WR, "ask and wait for an explicit yes", /explicit yes|asked the user and waited|ask[^.]{0,40}wait/i);
    rule(WR, "runs without permission prompts, so the limits are the barrier", /without permission prompts/i);
    // These two live in Step 4, where the scratch directory is actually used.
    rule(W, "a mktemp -d scratch directory is the one way out", /mktemp -d/);
    rule(W, "the scratch directory is deleted", /delete it[^.]{0,80}(done|next report)/i);
  });

  it("W2 — never destroy or undo what it did not create", () => {
    rule(WR, "destruction is named as a class", /destroy|destructive/i);
    rule(WR, "rm -rf is an example", "`rm -rf`");
    rule(WR, "git history/reset is an example", /git reset --hard/);
    rule(WR, "no archiving, killing or deleting agents", /(archive|kill|delete)[^.]{0,40}agent/i);
    rule(WR, "leaves what it did not create alone", /did not create|existed before you started/i);
    // Four verbs, each required on its own inside RULES: an alternation would
    // pass on one, and the whole file contains all four for other reasons.
    rule(WR, "never reverts someone else's change", /revert/i);
    rule(WR, "never reformats someone else's change", /reformat/i);
    rule(WR, "never stages someone else's change", /stage|`git add`/i);
    rule(WR, "never discards someone else's change", /discard/i);
    // …but editing a file or a bead in scope is the job, not a violation.
    rule(WR, "editing in scope is the work itself", /inside the request's scope is the work|editing[^.]{0,60}is the work/i);
    rule(W, "never deletes a bead", /never delete a bead/i);
    rule(WR, "stops and asks instead", /stop[^.]{0,30}ask/i);
  });

  it("W3 — never reads or copies secrets", () => {
    rule(WR, "reading or copying secrets is out", /(never|no)[^.]{0,40}(read|copy)[^.]{0,40}secret/i);
    rule(WR, ".env is an example", "`.env`");
    rule(WR, "credentials, tokens or keys", /credential|token|key/i);
  });

  it("W4 — never makes a check look green", () => {
    rule(
      WR,
      "no bending a test, an assertion or an acceptance criterion",
      /(change|weaken|edit|delete|rewrit)[^.]{0,90}(test|assertion|acceptance criteri)[^.]{0,90}(pass|green)/i,
    );
    rule(WR, "a red check means the code or the bead is wrong", /red check means/i);
    rule(WR, "the two allowed answers are fix the code or ask", /fix the code/i);
    rule(WR, "asking means sending blocked", /send `blocked`/);
    rule(WR, "never overrides a tracker guard", /`--force`/);
    // The closing procedure itself lives in Step 4.
    rule(
      W,
      "the check result is read before the bead is closed",
      /(read|reading)[^.]{0,90}(result|exit status|see (it )?pass)/i,
    );
    rule(W, "output with failures is not evidence", /failures is not evidence|failing checks/i);
    rule(W, "an unmet acceptance criterion is not evidence either", /acceptance criterion the bead does not[^.]{0,20}meet|unmet acceptance criteria/i);
    rule(W, "closing needs evidence", /only with evidence|with evidence/i);
  });

  it("W5 — never decides what only the user can decide", () => {
    rule(WR, "the request is the scope", /the request is the scope/i);
    rule(WR, "anything beyond the request is a suggestion", /suggestion, not work/i);
    rule(WR, "never continues on a self-chosen default", /default you (chose|picked)/i);
    rule(WR, "waits after asking", /and wait/i);
    // The channel is described where the questions are written.
    rule(W, "no interactive question tool", /AskUserQuestion/);
  });
});

describe("worker.md — what the job is", () => {
  it("names the user's change as the job and beads as the instrument (owner, 2026-09-17)", () => {
    rule(W, "the job is the change the user asked for", /job is the change the user asked for/i);
    rule(W, "beads are the instrument, not the goal", /instrument, not your goal/i);
    rule(W, "the work may not be code at all", /document, a configuration, a piece of research/i);
    rule(W, "a tidy graph around unasked work is a failure", /failed request/i);
  });

  it("states the precedence between this file and the skills, positively", () => {
    rule(W, "skills say how", /[Ss]kills say HOW/);
    rule(W, "this file decides the limits, the budget, reporting, asking and scope", /this file\n?\s*decides|\*\*this file[\s\S]{0,20}decides\*\*/);
    rule(W, "and why", /a skill cannot know what you are allowed to do/i);
  });
});

describe("worker.md — the workflow", () => {
  it("sizes by an ordered rule where risk beats apparent size", () => {
    order(W, "tier rule order", "→ **Large**", "→ **Small**", "→ **Medium**");
    rule(W, "first match wins", /FIRST match wins/);
    rule(W, "bead count is never evidence", /number of beads is never evidence/i);
    rule(
      W,
      "a tier or size the user sets wins",
      /(override|sets?)[^.]{0,50}(tier|size)|(tier|size)[^.]{0,50}(the user|Manager)[^.]{0,30}(set|override)/i,
    );
    
  });

  it("pins the tier table: documents, plan, skills, batches and the budget", () => {
    // Pinned by content, not by the step number it used to carry: which skills
    // a tier runs is the decision; where the chain lives is layout.
    expect(W).toMatch(
      /\| Skills[^|]*\| none[^|]*\| `feature-workflow`, `polishing-beads`, `implementing-beads`; with a plan also `reviewing-plan`, `converting-plan-to-beads` \| all five \|/,
    );
    expect(W).toMatch(/\| Plan \| none \| only when the work needs one/);
    expect(W).toMatch(/\*\*Total review calls per request\*\* \| \*\*1\*\* \| \*\*4\*\* \| \*\*6\*\*/);
    verbatim(W, "plus 1 re-review only if blocking findings remain");
    rule(W, "Small writes no new document file", /no new document file/);
    rule(W, "Large waits for the user before implementing", /\*\*ask the user to confirm and wait\*\*/);
  });

  it("holds the whole job in one loop, with the tier branches inside it", () => {
    const loop = between(W, "One loop, from the request", "## How big is this");
    order(
      loop,
      "the loop",
      "**Size the request**",
      "`received`",
      "Ask what you cannot answer",
      "**Small** —",
      "**Medium** —",
      "**Large** —",
      "Implement the request's beads one at a time",
      "Review the implementation as one batch",
      "`finished`",
    );
    const small = between(loop, "**Small** —", "**Medium** —");
    order(small, "Small path", "one short bead", "make the change", "cheapest check", "close with evidence", "one review", "`finished`");
    const medium = between(loop, "**Medium** —", "**Large** —");
    for (const step of ["with a plan: `reviewing-plan`", "write the beads by hand", "`polishing-beads`", "batch `b1`, stage `plan`", "`beads-done`", "batch `b2`"]) {
      expect(medium, step).toContain(step);
    }
    const large = between(loop, "**Large** —", "Implement the request's beads");
    order(
      large,
      "Large chain",
      "document chain",
      "plan",
      "`reviewing-plan`",
      "batch `b1`",
      "`plan-ready-for-beads`",
      "`converting-plan-to-beads`",
      "`polishing-beads`",
      "batch `b2`",
      "`beads-done`",
      "**ask the user to confirm and wait**",
      "batch `b3`",
    );
    verbatim(large, "`Plan-ready: PASS — <date>`");
  });

  it("treats skill passes as its own work, with a cadence per skill", () => {
    rule(W, "skill passes are not review calls", /[Ss]kill passes are yours, not review calls/);
    rule(W, "reviewing-plan runs once per plan", /`reviewing-plan`:? once per plan/);
    rule(W, "converting-plan-to-beads runs once per plan", /`converting-plan-to-beads`:? once per plan/);
    rule(W, "polishing-beads runs once per wave", /`polishing-beads`:? once per wave/);
  });

  it("teaches the leaf contract with a worked bead, and sizes beads by outcome", () => {
    verbatim(W, "`reference/leaf-bead-checklist.md`");
    // The ten-part contract is now shown, not listed: one real bead of this
    // repository's graph, annotated with what each part buys (delta §4.8).
    // Review b3: the example must be ordinary user work, not paseo-bm's own
    // machinery, and it must show every part of the leaf contract.
    const example = between(W, "Here is a real one from a real request", "Primary Proof and Reversibility are the two");
    expect(example).not.toMatch(/bm-wp-|role-hook|paseo-bm/);
    for (const part of [
      "## Objective",
      "## Context",
      "## Scope",
      "## Components Touched",
      "## Dependencies",
      "## Assumptions",
      "## Acceptance Criteria",
      "## Validation / Definition of Done",
      "## Primary Proof",
      "## Reversibility",
      "## Provenance",
    ]) {
      expect(example, part).toContain(part);
    }
    rule(W, "the example says what Primary Proof and Reversibility buy", /prove itself and undo itself/);
    // The Provenance of a real bead names the request, not just the plan.
    expect(example).toMatch(/Request: req-\d{8}T\d{6}Z — "/);
    rule(W, "one leaf is one outcome", /ONE LEAF = ONE OUTCOME/);
    rule(W, "size is never judged by counts", /never judge size by file, line or bead counts/);
    verbatim(W, "`## Acceptance Criteria`", "`## Success Criteria`", "`br lint -s all`");
    rule(W, "an existing heading is never dropped", /(never drop|never goes away|never removes?)[^.]{0,40}heading|heading[^.]{0,40}(never goes away|is never dropped)/i);
    rule(W, "every new bead has a Provenance section", /`## Provenance`/);
    rule(W, "and it names the request id and the request itself", /the `requestId` and the\s+user's request in one quoted line/i);
  });

  it("labels every bead with feature:<slug> and stops when several beads match", () => {
    verbatim(W, "`feature:<slug>`", "`br list --label feature:<slug> --json`", "`feature:hoa-don`");
    rule(W, "several matches means stop and ask", /more than one → stop and ask/i);
  });

  it("implements one bead at a time and closes each one on its own evidence", () => {
    rule(W, "only one bead in progress", /only \*\*one\*\* bead `in_progress`/i);
    rule(W, "only this request's beads", /Never pick up other ready beads|only (on )?this request's beads/i);
    rule(W, "implementing-beads without parallel sub-agents", /never with parallel sub-agents/);
    order(
      W,
      "per-bead cycle",
      "`br update <id> --status in_progress`",
      "run the check that proves it",
      '`br close <id> --reason "<the evidence:',
    );
    rule(W, "no build command is not a reason to stop", /no build or test command is not a reason to stop/i);
    rule(W, "git status is read once before the first write", /`git status` once before your first write/);
    rule(W, "the cheapest check that proves it", /cheapest check/);
    rule(W, "a blocking finding reopens the bead", /`br reopen <id>`/);
    rule(W, "changes after finished form a new batch", /(form|are) a new batch `b<n>`/);
    rule(W, "a split makes siblings, never deletes", /SIBLING beads under the same parent/);
    verbatim(W, "`Split-from: <id>`");
    rule(W, "a bead never depends on its own children", /never make a bead depend on its own children/);
    // Closing per bead replaced closing everything after the final review.
    expect(W).not.toContain("When every bead is implemented, review");
  });

  it("names the cheapest evidence for work that is not code", () => {
    rule(W, "proof is the cheapest evidence the outcome happened", /cheapest evidence that the outcome/i);
    rule(W, "research proves itself with sources", /conclusion with its sources/);
    // Q-027: documents a Worker writes follow the target repository's language.
    rule(W, "documents follow the repository's folders and language", /repository's own\s+language \(English if it has none\)/);
    rule(W, "configuration proves itself by being read back", /read back|command's output/);
    rule(W, "no build command is not a reason to stop", /no build or test command is not a reason to stop/i);
  });

  it("asks at fixed moments, in one numbered set, and waits", () => {
    rule(W, "intake questions before any document", /on intake before any document/i);
    rule(W, "questions after reviewing-plan", /after `reviewing-plan`/);
    rule(W, "risk questions before implementing a Large request", /for Large, before implementing/i);
    // The twelve triggers became one principle with two halves (delta §4.3).
    rule(W, "ask when the answer changes what you build", /would change what you build/);
    rule(W, "ask when you are stuck", /when you are stuck/i);
    // Delta 20260918c-question-cards: the worked example is the `BM-QUESTIONS`
    // block the Manager's chat card reads, so its shape is pinned.
    rule(W, "a worked question set is shown", /Q1: Storage — [\s\S]{0,200}\(recommended\)/);
    verbatim(worker, "```\nBM-QUESTIONS\nrequestId: req-");
    rule(W, "asking ends the turn and waits for the answer", /Then end the turn and wait/);
    rule(W, "the example does not teach that silence is consent", /Silence is not an answer/);
    // Inside the example itself — the prose around it warns against that phrase.
    const questions = between(worker, "Q1: Storage — the request says", "```");
    expect(questions).not.toMatch(/unless you say otherwise/);
    expect(questions).not.toMatch(/I will (take|go|start)/);
    expect(questions.match(/\(recommended\)/g), "one recommendation per question").toHaveLength(2);
    // First live run (F7): five points in the chat, four in `blockers`, so the user saw four.
    rule(W, "a point for the user is never left only in the chat", /never a\s+remark left only in your chat/i);
    rule(W, "the example says what makes a question answerable", /every option is named/);
    rule(W, "a moment with nothing to ask is skipped", /skip a moment with nothing to ask/i);
    rule(W, "at most five numbered questions", /at most 5 numbered questions/i);
    rule(W, "each question carries options and a recommendation", /options, your recommendation/);
    rule(W, "every question goes into the BM-QUESTIONS block of the report's message", /in the same message a `BM-QUESTIONS` block with EVERY question/);
    rule(W, "blockers only points at the block", /`blockers:` saying only `2 questions: Q1, Q2 — see BM-QUESTIONS`/);
    rule(W, "question ids keep counting across the request", /keep counting across the request/i);
    rule(W, "exactly one recommendation per question", /exactly one `\(recommended\)`/);
    rule(W, "answers arrive as a BM-ANSWERS block", /`BM-ANSWERS` block/);
    rule(W, "an answer is an option pick or the user's own words", /`Q1: a — …` picks that option, `Q2: other — …` is the user's own words/);
    rule(W, "an answer to a question that is not open is not acted on", /not open[^.]{0,80}do not act on it/i);
    rule(W, "an unanswered question is asked again, never defaulted", /stays open: ask it again[^.]{0,60}never pick a default/i);
    for (const [name, pattern] of [
      ["deviate from an approved document", /deviat\w* from an approved document/i],
      ["change behaviour existing users rely on", /chang\w* behaviour (for )?existing users|behaviour existing users rely on/i],
      ["add a requirement beyond the user's words", /add\w* a requirement beyond the user's words/i],
      ["make a security trade-off", /mak\w* a security trade-off/i],
      ["edit a frozen document", /edit\w* a frozen document/i],
      ["delete or merge existing beads", /delet\w* or merg\w* existing beads/i],
      ["several beads match the labels", /more than one → stop and ask/i],
    ] as const) {
      rule(W, `stop-and-ask trigger: ${name}`, pattern);
    }
    // The single-question rule of delta 20260916-review-budget is gone.
    expect(W).not.toContain("Ask ONE clear question");
  });

  it("gets one review and one re-review per batch, and never fixes non-blocking findings", () => {
    rule(W, "a review is a message to a Reviewer agent", /review happens only when you send a message to a Reviewer|review happens only when you send a Reviewer agent a message/i);
    rule(W, "one review, then at most one re-review", /one review and, only if blocking findings remain, one re-review/i);
    // REQ-037(e): Small gets exactly one review, so a blocking finding there is
    // fixed and reported, never re-reviewed (review b3, B2).
    rule(W, "a Small request has exactly one review in all", /Small request is the exception: it has exactly one review/i);
    rule(W, "and a blocking finding there goes to the user, not to a second Reviewer", /never a second Reviewer message/i);
    rule(W, "a batch keeps its id", /keeps its `batchId`/);
    rule(W, "non-blocking findings are not fixed", /[Dd]o not fix non-blocking findings/);
    rule(W, "blocking findings after the re-review stop the work", /stop, send `blocked` with them, and ask the user/i);
    rule(W, "a re-review goes to the same Reviewer", /same Reviewer/);
    // Owner decisions Q17 and Q21: the plugin counts, the Worker does not.
    expect(W).not.toMatch(/guardrail/i);
    expect(W).not.toMatch(/userAllowedExtra/);
  });

  it("creates the Reviewer and briefs it with the stage's own criteria", () => {
    verbatim(
      W,
      "`create_agent`",
      "profile `bm-reviewer`",
      "`bm.role` = `reviewer`",
      "`bm.requestId`",
      "`bm.batchId` = the batch id",
      "`bm.version`",
    );
    // delta 20260917c K10, errata 2026-09-18 (owner decision Q1a of
    // req-20260918T035101Z): Paseo refuses a Reviewer that a `bypassPermissions`
    // Worker creates without a mode, before any hook runs. So the Worker passes
    // the concrete value the plugin writes into its Runtime facts, like the
    // Manager does for the Worker — never a selection rule of its own.
    expect(W).not.toMatch(/inspect_provider/);
    rule(W, "the Reviewer mode comes from the Runtime facts", /`settings\.modeId` = the Reviewer\s+mode in your `## Runtime facts`/);
    rule(W, "a missing mode line ends in blocked, not a guess", /missing: send `blocked` with Paseo's refusal/);
    expect(W).not.toMatch(/plugin sets the Reviewer's\s+mode/i);
    // Review b3: "cannot write or reach the network" was false of Codex auto.
    expect(W).not.toMatch(/cannot write or reach the network/);
    // The stage criteria moved here from reviewer.md: one Reviewer, one stage.
    // A Large b1 carries the plan, so that brief needs the plan criteria too.
    rule(W, "a documents batch that carries a plan names the plan criteria", /Large `b1` carries the plan too/);
    for (const criteria of [
      "`checklists/prd-ready.md`",
      "`reviewing-plan` in its review-only mode",
      "`converting-plan-to-beads/reference/leaf-bead-checklist.md`",
      "`implementing-beads`: the preflight",
    ]) {
      verbatim(W, criteria);
    }
    rule(W, "the brief carries the stage criteria", /the criteria for that stage/i);
    rule(W, "the review format is not pasted into the prompt", /Do not paste the `BM-REVIEW` format/);
  });

  it("treats only a stop message or an empty resume as a stop", () => {
    const stop = between(W, "A turn is a STOP only if it brings");
    rule(stop, "an empty turn after a cut-off is a stop", /\*\*nothing at all\*\*/);
    rule(stop, "instructions and finish notices are not stops", /These are NOT stops/);
    rule(stop, "a finish notification is not a stop", /a finish notification/);
    expect(stop.toLowerCase().indexOf("`cancel_agent`")).toBeLessThan(stop.toLowerCase().indexOf("send `finished`"));
    rule(stop, "nothing else happens on a stop", /do NOTHING else/i);
    // The plugin's own stop notice (`/bm-worker-stop-all`) is a stop by name,
    // so the Worker never has to infer it from wording (delta 20260917e §4.4).
    rule(stop, "a BM-STOP message is always a stop", /starts with `BM-STOP`[^.]{0,60}always a stop/i);
    // Pinned because the first draft of that delta would have broken both: it
    // told the Worker to call no further tool (deleting the `cancel_agent`
    // step) and to report `blocked`, which manager.md renders as a question
    // list — for a stop that has no questions.
    rule(stop, "the Reviewers it created are still cancelled", /`cancel_agent`/);
    rule(stop, "a stop is reported as finished, not blocked", /send `finished`/);
    expect(stop).not.toMatch(/`blocked`/);
  });

  it("reports to Manager with the exact BM-REPORT block", () => {
    rule(W, "reports go through send_agent_prompt", /`send_agent_prompt`/);
    rule(W, "SendMessage is not the channel", /SendMessage/);
    rule(W, "reports do not wake the Manager", /`notifyOnFinish: false`/);
    rule(W, "Reviewer calls keep the default so a verdict wakes the Worker", /a verdict wakes you/);
    rule(W, "reports go out only at the four moments", /Report \*\*only\*\* at `received`[^.]{0,120}`finished`/i);
    rule(W, "Small reports twice", /Small sends only `received` and `finished`/);
    rule(W, "no progress updates in between", /no progress updates (in )?between/i);
    rule(W, "bead fields hold full ids only", /full ids only, comma-separated/);
    rule(W, "skillsUsed lists the skills loaded so far", /`skillsUsed` lists the skills you loaded/);

    const block = worker.slice(worker.indexOf("BM-REPORT\nrequestId"));
    verbatim(
      block,
      "BM-REPORT",
      "requestId: <requestId>",
      "phase: received | beads-done | blocked | finished",
      "tier: Small | Medium | Large (changed: no | from <old tier>, reason)",
      "filesChanged:",
      "beadsCreated:",
      "beadsUpdated:",
      "beadsClosed:",
      "beadsReady:",
      "reviewFindingsOpen:",
      "buildAndTests:",
      "skillsUsed: <skill names, comma-separated>",
      "blockers:",
    );
    expect(block.indexOf("skillsUsed:")).toBe(block.indexOf("\n", block.indexOf("buildAndTests:")) + 1);
    expect(block.indexOf("blockers:")).toBeGreaterThan(block.indexOf("skillsUsed:"));
    expect(block).not.toContain("guardrail:");
  });
});

describe("reviewer.md — hard limits", () => {
  it("R1 — changes nothing, and a tool is not permission", () => {
    rule(RR, "read-only is stated", /READ-ONLY|change nothing/i);
    // …and stated without a place attached. Scoping it ("change nothing IN THE
    // REPOSITORY") leaves writing to a skill directory or a global git config
    // under no limit at all, since R2 only covers network, installs and
    // downloads. Found by the b2 re-review.
    expect(RR, "the change-nothing limit must not be scoped to one place").not.toMatch(
      /change nothing (in|inside|within|to|under)\b/i,
    );
    rule(RR, "having a tool is not permission", /permission to use it|not permission/i);
    rule(RR, "never edits a file", /(never|no)[^.]{0,50}(modify|edit|change)[^.]{0,30}file/i);
    rule(RR, "never changes a bead", /(never|no)[^.]{0,60}bead/i);
    rule(RR, "never writes through git", /(never|no)[^.]{0,60}git/i);
    // The Reviewer can hold agent tools; only these words stand between it and
    // using them, and archiving or deleting an agent is the user's alone.
    about(RR, "agent", 200, /creat/i, /archiv/i, /delet/i, /(stop|kill|cancel|message)/i);
    rule(
      RR,
      "never archives or deletes an agent",
      /(never|no)[^.]{0,60}(archive|delete)[^.]{0,40}agent|agents?[^.]{0,30}(never|no)[^.]{0,60}(archiv|delet)/i,
    );
    // A check it cannot run is reported, not skipped silently — and that
    // landing place covers all four limits, not only the ones about changing.
    rule(
      RR,
      "a check any limit holds back goes to notChecked, not just one that changes something",
      /(anything|any of)[^.]{0,60}(limits?|above)[^.]{0,60}`notChecked`|`notChecked`[^.]{0,40}(anything|any of)/i,
    );
    rule(RR, "its own scratch directory is not a change", /scratch directory[^.]{0,40}not a change|not a change — see/i);
  });

  it("R2 — nothing leaves the machine", () => {
    // Negated forms: a bare /network/i would pass on text saying the opposite.
    rule(RR, "no network", /(no|never)[^.]{0,20}network/i);
    rule(RR, "no installing", /(no|never)[^.]{0,20}install/i);
    rule(RR, "no downloading", /(no|never)[^.]{0,20}download/i);
  });

  it("R3 — never reads secrets, and reports an added one without repeating it", () => {
    rule(RR, "secrets are off limits", /(never|no)[^.]{0,40}(read )?secret/i);
    rule(RR, "an added secret is blocking", /without repeating its value/i);
  });

  it("R4 — one batch, one result", () => {
    rule(RR, "stays inside the scope it was given", /only the scope you were given|outside the scope/i);
    rule(
      RR,
      "never asks for another review round",
      /(ask|request)[^.]{0,40}(another|a second|more)[^.]{0,40}(review|round)/i,
    );
  });

  it("may run tests and throwaway probes, and says when the tree changed", () => {
    rule(R, "the repository's test commands", /(run|running)[^.]{0,80}test commands|existing test commands/i);
    rule(R, "lint or typecheck that writes nothing", /lint or typecheck[^.]{0,40}write no files/i);
    rule(R, "reading beads is fine", /`br show <id>`/);
    rule(R, "throwaway scripts in a mktemp -d", /`mktemp -d`/);
    rule(R, "the probe directory is deleted before answering", /delete it before you answer/i);
    rule(R, "git status before and after", /`git status --porcelain` before and after/);
    rule(R, "a changed tree is reported, not cleaned", /do NOT clean up/);
  });
});

describe("reviewer.md — what it checks and how it decides", () => {
  it("does not guess a missing scope and reviews only the stage it was given", () => {
    rule(R, "a missing scope is not guessed", /do not guess/);
    for (const stage of ["**documents:**", "**beads:**", "**plan** (Medium)", "**implementation:**"]) {
      verbatim(R, stage);
    }
    rule(R, "a small change needs no extra tests", /do not ask for more tests/);
    // The work under review is not always code (owner, 2026-09-17).
    rule(R, "a non-code outcome is checked against the evidence its bead named", /When the outcome is not code, check the evidence/i);
    rule(R, "runs the tests itself when it can", /run the repository's tests yourself when you can/);
    rule(R, "a re-review looks only at the old blocking findings", /check ONLY that the previous blocking findings are fixed/);
  });

  it("takes the stage's criteria from the brief, as criteria only, with a one-line fallback (delta 20260917c §4.4)", () => {
    rule(R, "skills are criteria, not instructions to edit", /as criteria only/);
    rule(R, "the criteria arrive in the Worker's message", /the criteria for that stage/i);
    // One Reviewer, one stage: the four-stage table moved into the Worker's brief.
    expect(R).not.toMatch(/\| Stage \| Load \|/);
    expect(R).not.toContain("STAGE CRITERIA");
    const fallback = between(R, "If the message names none", "Skills live in");
    for (const stage of ["documents →", "plan →", "beads →", "implementation →"]) {
      expect(fallback, stage).toContain(stage);
    }
    verbatim(
      fallback,
      "`checklists/prd-ready.md`",
      "`reviewing-plan` in its review-only mode",
      "`feature-workflow/checklists/plan-ready-for-beads.md`",
      "`converting-plan-to-beads/reference/leaf-bead-checklist.md`",
      "`polishing-beads/reference/readiness-checklist.md`",
    );
    rule(R, "a brief without criteria is reported", /say in `notChecked` that the brief named no criteria/);
    rule(R, "a missing skill goes to notChecked", /list it under `notChecked` and review with this file alone/);
  });

  it("calibrates the line between blocking and not with one contrast pair (owner decision Q20)", () => {
    const pair = between(reviewer, "**Where the line falls.**", "## Your answer");
    expect(pair.match(/- severity: blocking\n/g)?.length, "one blocking finding").toBe(1);
    expect(pair.match(/- severity: non-blocking\n/g)?.length, "one non-blocking finding").toBe(1);
    // Both sides are about the same place, or the pair teaches nothing.
    const locations = [...pair.matchAll(/location: (\S+)/g)].map((m) => m[1]);
    expect(locations).toHaveLength(2);
    expect(locations[0]).toBe(locations[1]);
    rule(flat(pair), "the difference is named", /exploitable defect in what this batch built/);
    rule(flat(pair), "the other side is protection nobody asked for", /protection nobody asked for/);
  });

  it("tries abuse cases on sensitive batches", () => {
    rule(R, "sensitive batches are named", /SENSITIVE BATCHES/);
    for (const abuse of [
      "authorization bypass",
      "session revocation",
      "check-then-write races",
      "malformed input",
      "unbounded resources",
      "secret exposure",
    ]) {
      verbatim(R, abuse);
    }
    rule(R, "what was tried is listed in checked", /list the ones you tried in `checked`/);
  });

  it("blocks only what is wrong or unsafe for the request", () => {
    rule(R, "review against the request", /REVIEW AGAINST THE REQUEST, NOT AGAINST PERFECTION/);
    rule(R, "a bug or a failing check is blocking", /a bug, a failing check/);
    rule(R, "a weakened test is blocking", /(test|assertion|acceptance criterion)[^;]{0,90}(weakened|deleted)[^;]{0,60}pass/i);
    rule(R, "a bundled or proof-less Medium/Large leaf is blocking", /bundles several outcomes|lacks Primary Proof or Reversibility/);
    rule(R, "beads batch and Medium plan batch both count", /in a `beads` batch, or among the beads of a Medium `plan` batch/);
    rule(R, "a guessed decided value is blocking", /forces an implementer to guess a decided value/);
    rule(R, "unasked work is never blocking", /ANY WORK THE REQUEST DID NOT ASK FOR/);
    rule(R, "hardening beyond the request is never blocking", /HARDENING BEYOND THE REQUEST/);
    rule(R, "unless it is an exploitable defect", /unless it is an exploitable defect in what was built/);
    rule(R, "at most three non-blocking findings", /At most three non-blocking findings/);
  });

  it("returns the exact BM-REVIEW block", () => {
    verbatim(
      reviewer,
      "BM-REVIEW",
      "requestId: <requestId>",
      "batchId: <batchId>",
      "reviewKind: first | re-review",
      "verdict: pass | changes-required",
      "checked: <what you read and ran: document paths, bead ids, diff paths, test results, abuse cases tried>",
      "findings:",
      "- severity: blocking | non-blocking",
      "  location: <file:line, or bead id>",
      "  reason: <why this is a problem>",
      "  suggestedFix: <what the Worker should change>",
      "notChecked: <anything in the scope you could not check, and why>",
    );
    rule(R, "the verdict follows the blocking findings", /Non-blocking findings alone never change the verdict/);
    rule(R, "an empty list is written findings: none", /With no findings write exactly `findings: none`/);
    rule(R, "the plugin owns the counters (owner decision Q17)", /the plugin counts review calls/);
    expect(R).not.toMatch(/the Worker counts/);
  });

  it("stops the same way however it is stopped", () => {
    const stop = between(R, "**One request, one result.**");
    rule(stop, "stopped by the Worker, the user or the notice", /by the Worker, by the user, or by the\s+plugin's notice/i);
    rule(stop, "no tool is called after a stop", /call no\s+tool/i);
  });

  it("answers the plugin's stop notice with one line", () => {
    verbatim(reviewer, "`STOP: The Beads Worker that created you was stopped by the user.`");
    expect(reviewer).toMatch(/```\n\s*BM-REVIEW STOPPED\n\s*```/);
  });
});

describe("manager.md — hard limits", () => {
  it("M1 — does not do the work", () => {
    rule(M, "delegates", /delegate/i);
    rule(MR, "writes no documents", /(never|not|no)[^.]{0,60}write[^.]{0,40}document/i);
    rule(MR, "touches no beads", /(never|not|no)[^.]{0,80}beads/i);
    rule(MR, "changes no code", /(change|changing|touch)[^.]{0,20}code/i);
  });

  it("M2 — relay, not decider, but the first prompt still follows the recipe", () => {
    rule(MR, "relay not decider", /relay, not a decider|relay rather than/i);
    rule(MR, "adds no work of its own", /DO NOT ADD WORK|add no (work|requirement)|no requirements[^.]{0,30}of your own/i);
    rule(MR, "a size the user gave is used", /user stated a size|size the user/i);
    rule(MR, "answers are passed on unchanged", /verbatim/i);
    verbatim(MR, "`Continue <requestId>.`");
    // Delta 20260918c-question-cards: the one fixed-shape exception.
    rule(MR, "answers to a Worker's questions go as the BM-ANSWERS block", /answers to its questions as the `BM-ANSWERS` block/);
    // b2 review: "and nothing else" also swallowed the six mandated
    // initialPrompt items, including the Manager's own id the Worker needs.
    rule(MR, "the first prompt follows its own recipe", /FIRST prompt[^.]{0,60}(recipe|step 2)|first prompt is the exception/i);
  });

  it("M3 — never says more than it can see", () => {
    rule(MR, "never reads another agent's conversation", /another agent's conversation/i);
    rule(MR, "reports and the status tools are the only sources", /`BM-REPORT`[^.]{0,80}(status|activity)/i);
    // The plugin speaks to the Manager too (`BM-BUDGET`); without this the
    // limit would forbid acting on its own notices (review b3).
    rule(MR, "the plugin's own notices count as a source", /the plugin's own notices \(they start with `BM-`\)/);
    rule(MR, "says so when it does not know", /(say|admit|tell)[^.]{0,80}(do not|don't) know/i);
  });

  it("M4 — agents belong to the user, and cancel is the one exception", () => {
    rule(
      MR,
      "never archives or deletes an agent",
      /(never|not)[^.]{0,40}(archive|delete)[^.]{0,40}agent|agents?[^.]{0,30}(never|not)[^.]{0,50}(archiv|delet)/i,
    );
    rule(MR, "never approves a permission request", /(never|not)[^.]{0,40}approve[^.]{0,40}permission/i);
    rule(MR, "may cancel a stuck Worker, and only then", /MAY[^.]{0,40}cancel/i);
    // The cases belong in RULES too: without them the limit forbids what the
    // body tells the Manager to do (review b3).
    rule(MR, "the cancel cases are in the limit itself", /stuck or off\s+course/i);
    rule(MR, "including an agent that was created broken", /creation left a broken agent behind/i);
    // The limit must not swallow step 2: creating and prompting the Worker is
    // the Manager's job, and an earlier wording of M4 forbade it (b2 re-review).
    rule(MR, "creating and prompting the Worker stays its own job", /(creating|create)[^.]{0,60}(is your own job|step 2)/i);
    // b2 review: the tool name and the word "only" were lost, leaving the
    // Manager to guess between cancel_agent, kill_agent and archive_agent.
    verbatim(MR, "`cancel_agent`");
    rule(MR, "cancelling is limited to those cases", /\bonly when\b/i);
    rule(MR, "always says why it cancelled", /tell the user why|say why/i);
    rule(M, "archiving is explained as the user's own action", /the user's own action/i);
    rule(M, "a user who asks to stop a Worker is obeyed", /user asks to stop a Worker:\*\* cancel its run/i);
    rule(M, "and told the Worker must stop its Reviewers", /stop its Reviewers and leave a final report/i);
  });

  it("M5 — never reads or prints secrets, including the environment", () => {
    rule(MR, "no environment scanning", /(never|not|no)[^.]{0,60}environment/i);
    verbatim(MR, '`$PASEO_AGENT_ID`');
  });

  it("does not carry the Worker's own limits (owner decision, 2026-09-16)", () => {
    expect(M).not.toContain("NEVER commit, push, open pull requests");
  });
});

describe("manager.md — how it runs a request", () => {
  it("delegates before it checks anything else", () => {
    order(M, "delegate first", "2. **Delegate now", "4. **Then check skills**");
    rule(M, "no lookups before delegating", /Do not check skills, search tools or list agents first/);
  });

  it("guesses the size with the same ordered rule as the Worker", () => {
    order(M, "tier rule order", "→ **Large**", "→ **Small**", "→ **Medium**");
    rule(M, "bead count is never evidence", /number of beads is never evidence/i);
  });

  it("spells out a create_agent call that succeeds first time", () => {
    verbatim(
      M,
      "`list_profiles` **once**",
      "`provider` = `bm-worker/<model of the profile>`",
      "`bm.role` = `worker`",
      "`bm.requestId` = the `requestId`",
      "`bm.version`",
      "`req-` + current UTC time as `YYYYMMDDTHHMMSSZ`",
      "Do only what the request asks.",
    );
    // Without the Manager's own id in the first prompt the Worker has nowhere
    // to send its reports (review b3).
    rule(M, "the first prompt carries the Manager's own agent id", /your agent id \(`\$PASEO_AGENT_ID`\)/);
    // delta 20260917c K10 + Q22: Paseo refuses a Worker without a mode before
    // any hook runs, so the Manager still passes one — the concrete value the
    // plugin writes into its Runtime facts, not a rule it has to apply.
    rule(M, "the mode comes from the Runtime facts", /`settings\.modeId` = the Worker mode named in the `## Runtime facts` section/);
    // Delta 20260921 §4.2.3: "Paseo refuses a Worker without one" is only true on
    // Claude and Codex; the rewritten sentence keeps the rule — a missing
    // Runtime-facts section fails loudly and is reported.
    rule(
      M,
      "a missing mode fails loudly and is reported",
      /Paseo refuses to create a Worker\s+without one/,
      /If that section is missing, the creation fails with\s+Paseo's own list of modes, which you report/,
    );
    expect(M).not.toMatch(/inspect_provider/);
    expect(M).not.toMatch(/bypassPermissions|full-access|colorTier/);
    rule(M, "the Worker's own instructions are not repeated", /The Worker already has its own instructions/);
  });

  it("checks the five skills in the three directories and never blocks on them", () => {
    for (const skill of [
      "`feature-workflow`",
      "`reviewing-plan`",
      "`converting-plan-to-beads`",
      "`polishing-beads`",
      "`implementing-beads`",
    ]) {
      verbatim(M, skill);
    }
    verbatim(M, "`~/.agents/skills`", "`~/.claude/skills`", "`~/.codex/skills`", "`npx paseo-bm doctor`");
    rule(M, "an absent codex directory is normal", /an absent `~\/.codex\/skills` is normal/);
    rule(M, "a missing skill never blocks", /Keep going/);
  });

  it("answers a `received` report with one line", () => {
    rule(M, "received is acknowledged in one line", /\*\*`received`:\*\* one line/);
    rule(M, "and nothing more is due until the Worker speaks again", /Nothing else is due until it asks or\s+finishes/i);
  });

  it("asks the user on a budget notice, and still checks the skills a tier requires", () => {
    // Owner decisions Q17 and Q21: the plugin counts; on an overrun the Manager
    // asks the user, because the user may have allowed the calls in the
    // Worker's chat. The Manager no longer carries its own budget table.
    expect(M).not.toMatch(/\*\*Total review calls per `requestId`\*\*/);
    verbatim(M, "`BM-BUDGET`");
    rule(M, "asks the user whether to continue or cancel", /ask the user whether to\s+continue or to cancel/i);
    rule(M, "never cancels on the notice alone", /Never cancel on the notice\s+alone/);
    // "Continue" means sending nothing: a message replaces the turn the Worker
    // is in, so an encouraging reply would destroy the work (review b3).
    rule(M, "a continue answer sends the Worker nothing", /send the Worker nothing/);
    rule(M, "and a cancel answer says what is unfinished", /cancel the run and say what is unfinished/i);
    expect(M).not.toMatch(/If a limit is exceeded without permission: cancel/);
    verbatim(
      M,
      "Large: `feature-workflow`, `reviewing-plan`, `converting-plan-to-beads`, `polishing-beads`, `implementing-beads`",
      "Medium: `feature-workflow`, `polishing-beads`, `implementing-beads`",
    );
    rule(M, "a missing skill is reported, not punished", /Do not cancel the\s+Worker for it/);
  });

  it("keeps the user informed from what it can actually see (delta 20260917c §4.5)", () => {
    rule(M, "a follow-up goes to the Worker that already has the request", /follow-up to an existing request goes to that\s+Worker/i);
    // Delta 20260917f: the owner typed `/bm-worker-new` and the Manager folded
    // the words into the Worker already busy, turning parallel work serial.
    rule(M, "the new-request flag always means new work", /`BM-NEW-REQUEST`\*\*[^.]{0,80}always new work/i);
    rule(M, "and gets its own Worker even while others run", /NEW Worker even while others run/i);
    rule(M, "never handed to a Worker that already has a request", /never one that already has\s+a request/i);
    rule(M, "the request is what follows the flag line", /request is the rest of the message/i);
    rule(M, "the user is told how many Workers now run", /say how many Workers\s+now run/i);
    // The hazard the file knew about in one place and not in the relay path.
    rule(M, "never messages a running Worker", /NEVER send to a Worker that is `running`/);
    rule(M, "because a message destroys the turn", /replaces the\s+turn it is in and throws that work away/i);
    rule(M, "the words are held, not dropped", /Hold the user's words/);
    rule(M, "and sent when that Worker's turn ends", /send when Paseo wakes you at that Worker's turn end/i);
    rule(M, "progress questions are answered from the last report, with its age", /answer from the last report and the\s+agent status, and say how old/i);
    rule(M, "two sources that disagree are both named", /which source said what/i);
    rule(M, "progress is never invented", /never invent progress/i);
  });

  it("keeps its own right to cancel a stuck Worker (REQ-020d), which Q21 did not change", () => {
    rule(M, "a stuck or off-course Worker is cancelled and the user told why", /stuck or off course:\*\* cancel its run, tell the user why/);
  });

  it("reports each Worker phase the way the user needs it", () => {
    rule(M, "a Large beads-done waits for the user", /For a \*\*Large\*\* request say the Worker is waiting for the user's confirmation/);
    rule(M, "never announces implementation early", /never say it started implementing before the user answered/);
    // Delta 20260918d-card-replies (owner decision Q1): every report reaches
    // the user as a card, so the Manager says only what the card does not. The
    // questions of a `BM-QUESTIONS` block are on the card's buttons and are
    // never repeated; a report without the block has no buttons, so its
    // questions from `blockers` are still shown in full. This pair replaces the
    // single 20260918c rule "show the user EVERY question — from the block,
    // else from `blockers`": each half is now pinned on its own.
    rule(M, "the card is never repeated", /Never repeat what the card shows/);
    rule(M, "a question block's questions and options are not repeated", /`BM-QUESTIONS` block's questions and options: never repeat them/);
    rule(M, "a report without the block still gets every question from blockers", /A report without that block has no buttons: show its questions from `blockers` in full/);
    rule(M, "questions keep their options and recommendation", /with its options and the Worker's recommendation/);
    rule(M, "an already-answered question is not relayed twice", /If the user tells you they already answered the Worker, do not relay it again/);
    // The waiting line names the Worker, its request and its questions by the
    // Worker's own ids (the owner's Q1 wording); the letter labels are for
    // answering in the chat.
    rule(M, "every waiting Worker gets a letter", /every Worker still waiting under a letter \(A, B, …\)/);
    verbatim(manager, "`A · <name> · <requestId>: Q6, Q7`");
    rule(M, "a question is labelled by the Worker's letter and its own number", /A6 = Worker A's Q6/);
    rule(M, "old reports keep the Worker's own numbers", /old reports keep the Worker's numbers/);
    rule(M, "the user answers in the card or in the chat", /answers in the Worker's card or here as `A6 a, B1 b`/);
    rule(M, "the answer is read against the latest list", /against your latest list/);
    rule(M, "each Worker gets only its own answers", /send each Worker only its own answers/);
    rule(M, "never to a running Worker", /once it is not `running`/);
    verbatim(
      manager,
      "`Continue <requestId>.`, then:\n  ```\n  BM-ANSWERS\n  requestId: <requestId>\n  Q6: a — <the option as the Worker wrote it>\n  Q7: other — <the user's own words>\n  ```",
    );
    rule(M, "an answer that fits no single question is asked back, not guessed", /fits no single open question: ask the user, send nothing for it/);
    rule(M, "the Manager never picks for the user", /never pick an option for them/);
    rule(M, "a Worker that reported again is not answered again", /reported again has had its answers[^.]{0,40}relay nothing more/);
    // Delta 20260918d: the card lists the suggestions; the Manager counts them
    // and still asks the user which, if any, becomes new work.
    rule(M, "suggestions are counted and put to the user", /how many `Suggestion \(not done\)` items[^.]{0,60}ask which, if any, becomes new work — the user decides/);
    // The Manager can only relay them because the Worker puts them in `blockers`.
    rule(W, "the Worker puts its suggestions in blockers", /goes in `blockers`[^.]{0,80}`none\. Suggestion \(not done\): …`/i);
    rule(M, "a turn that ended without a report is not news", /A Paseo notice that the Worker ended a turn WITHOUT a new `BM-REPORT`/);
    rule(M, "an error or a permission wait is told", /if the Worker errored or waits for a permission, tell the user/);
    rule(M, "otherwise one status line", /otherwise reply with ONE status line/);
  });

  it("keeps its replies short, on topic, and shows an old-style question list in full", () => {
    rule(M, "replies stay short", /keep replies to the user to a few lines/i);
    rule(M, "an old-style blocked list is shown in full", /which you show in full/);
    rule(
      M,
      "notices that are not about the request never reach the user",
      /(never mention|never reach the user|do not mention)[^.]{0,120}notices?|notices?[^.]{0,120}(not about (it|the request))/i,
    );
  });
});

describe("across the three files (delta 20260917c)", () => {
  const fenced = (text: string) => [...text.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

  it("gives the two agents that run a loop exactly one 'what you do next' section", () => {
    for (const [name, text] of [["worker.md", worker], ["manager.md", manager]] as const) {
      expect(text.split("\n").filter((line) => line === "## What you do next"), name).toHaveLength(1);
    }
  });

  it("teaches mode selection nowhere: the plugin owns it (K10, Q22)", () => {
    // Outside the worked examples: worker.md's example bead is ABOUT the hook
    // that downgrades a full-access Reviewer, which is content, not instruction.
    const prose = (text: string) => flat(text.replace(/```\n[\s\S]*?```/g, ""));
    for (const [name, text] of [["worker.md", worker], ["reviewer.md", reviewer], ["manager.md", manager]] as const) {
      expect(prose(text), name).not.toMatch(/inspect_provider/);
      expect(prose(text), name).not.toMatch(/colorTier|bypassPermissions|full-access/);
    }
    // The only places a mode is still passed name the section the plugin
    // writes: the Manager for its Worker and, since errata 2026-09-18 of
    // delta 20260917c §4.6, the Worker for its Reviewer.
    verbatim(M, `\`${RUNTIME_FACTS_HEADING}\``);
    verbatim(W, `\`${RUNTIME_FACTS_HEADING}\``);
    expect(W.match(/settings\.modeId/g)).toHaveLength(1);
    expect(R).not.toMatch(/settings\.modeId/);
  });

  it("carries no self-reported guardrail anywhere (Q17)", () => {
    for (const [name, text] of [["worker.md", W], ["reviewer.md", R], ["manager.md", M]] as const) {
      expect(text, name).not.toMatch(/guardrail|userAllowedExtra/i);
    }
  });

  it("tells the Manager what the plugin's budget notice asks, in the same words (Q21)", () => {
    const notice = flat(budgetNotice({ requestId: "req-X", tier: "Large", calls: 7, budget: 6, managerAgentId: "m" }));
    const asked = "ask the user whether to continue or to cancel";
    expect(notice.toLowerCase()).toContain(asked);
    expect(M.replace(/\*\*/g, "").toLowerCase()).toContain(asked);
    expect(notice.startsWith(BUDGET_NOTICE_MARKER)).toBe(true);
    verbatim(M, `\`${BUDGET_NOTICE_MARKER}\``);
  });

  it("shows worked examples as examples, not as lists of rules (§4.8)", () => {
    const workerBlocks = fenced(worker);
    expect(workerBlocks.some((block) => block.includes("## Primary Proof") && block.includes("## Reversibility")), "a bead").toBe(true);
    // Delta 20260918c-question-cards: the question set is the `BM-QUESTIONS` block.
    expect(
      workerBlocks.some((block) => /^BM-QUESTIONS\nrequestId: .+\nQ1: .+\n- a: .+\(recommended\)\n- b: /m.test(block)),
      "a question set",
    ).toBe(true);
    const pair = fenced(reviewer).find((block) => block.includes("severity: blocking\n") && block.includes("severity: non-blocking\n"));
    expect(pair, "a contrast pair").toBeDefined();
    // An example is concrete: it names a real place, not a placeholder.
    expect(pair).not.toMatch(/<file:line/);
  });
});

describe("the RULES budget", () => {
  // Owner, 2026-09-17: "cấm những thứ thật sự lớn thay vì lắt nhắt case by
  // case". Seven deltas each added a bullet to `## RULES` and none ever merged
  // one, which is how 38 bullets piled up across the three files. This is the
  // ceiling that keeps that from happening again: a later delta wanting one
  // more limit has to drop another, or raise the ceiling on purpose and say why
  // in its own document.
  //
  // Counting prohibition words was tried first and dropped: it also matches
  // "do not know", "do not relay it again" and "do not retry in a loop", which
  // are instructions, not limits on the agent's power — by that metric
  // manager.md scored worse after the simplification, which is nonsense.
  // Numbers below are the measured block plus four lines of headroom.
  it.each([
    ["worker.md", worker, 5, 34],
    ["reviewer.md", reviewer, 4, 18],
    ["manager.md", manager, 5, 29],
  ])("%s states exactly %i hard limits, in at most %i lines", (name, text, limits, lines) => {
    const block = rulesBlock(text);
    expect(block.filter((line) => /^\d+\. \*\*/.test(line)).length, `${name}: numbered limits`).toBe(limits);
    expect(block.length, `${name}: RULES block length`).toBeLessThanOrEqual(lines);
    // A sixth limit must not arrive disguised as a bullet under the numbers.
    expect(block.filter((line) => /^[-*] /.test(line)).length, `${name}: stray bullets`).toBe(0);
  });
});

describe("the plugin's BM-FORMAT notice (delta 20260918g §4.10, REQ-061 j)", () => {
  // Verbatim from the design: each role learns what the notice is and what to
  // send back, and that it is not the user's words.
  it.each([
    [
      "worker.md",
      worker,
      "A message that starts with `BM-FORMAT` comes from the plugin, not the user: your last block broke the template. Send the whole corrected block again, to the same agent, in one message, changing nothing else; do not redo work, then carry on where you were.",
    ],
    [
      "manager.md",
      manager,
      "A message that starts with `BM-FORMAT` is the plugin's: your last `BM-ANSWERS` broke the template. Send the corrected block again to that Worker once it is not running; say nothing to the user about it.",
    ],
    [
      "reviewer.md",
      reviewer,
      "A message that starts with `BM-FORMAT` is the plugin's: answer with the whole corrected `BM-REVIEW` block only; do not review again.",
    ],
  ])("%s carries its rule word for word", (_name, text, rule) => {
    expect(text.replace(/\s+/g, " ")).toContain(rule);
  });

  it("sits where each role already hears about the plugin's messages", () => {
    expect(between(worker, "## Reporting", "## Stop").replace(/\s+/g, " ")).toContain("starts with `BM-FORMAT`");
    expect(between(manager, "## Talking to the user").replace(/\s+/g, " ")).toContain("starts with `BM-FORMAT`");
    expect(between(reviewer, "## Your answer", "## Stop").replace(/\s+/g, " ")).toContain("starts with `BM-FORMAT`");
  });
});
