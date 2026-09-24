import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNTIME_FACTS_HEADING } from "../plugin/server/role-extras";
import { budgetNotice } from "../plugin/server/review-budget";
import { formatNotice } from "../plugin/server/format-check";
import { WORKER_CLOSING } from "../plugin/server/fallback-handover";
import { managerIdNotice, settingsNotice } from "../plugin/server/settings-notices";
import { RESUME_NOTICE } from "../plugin/server/fallback-wait";
import { toolsNotice } from "../plugin/server/tools-check";

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

describe("reviewer.md says a prose field may run over several lines (fault L8, 2026-09-23)", () => {
  it("names the two fields and the indent that keeps the continuation inside the block", () => {
    expect(reviewer).toMatch(/`checked` and `notChecked` are prose: a long value may run over several/);
    expect(reviewer).toMatch(/lines, as long as every line after the first is indented\./);
  });
});

describe("worker.md teaches what the BM-REPORT check accepts (fault L2, 2026-09-23)", () => {
  it("says a short note may follow tier and reviewFindingsOpen, and where the line still is", () => {
    expect(worker).toMatch(/`tier` and\n`reviewFindingsOpen` may carry a short note after their structured part/);
    expect(worker).toMatch(/`reviewFindingsOpen` still opens with `none` or `b<n>: …`/);
    expect(worker).toMatch(/"b4 is still running" is not a value/);
  });
});

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
  //
  // manager.md 176 -> 177 for delta 20260921 phase 2a-15 (bead kj1p.5, owner
  // decision Q14 a of that delta, raised just enough): the Manager gains one
  // line for the plugin's BM-SETTINGS notice — its line replaces the matching
  // Runtime-facts line, else the next Worker creation passes a mode Paseo
  // refuses (design F5). The "Talking to the user" paragraph has no wrap slack
  // left (+1 line). worker.md took the same line within its ceiling: the "Per
  // bead" paragraph under "Proving a change" was re-wrapped (7 -> 6 lines).
  //
  // manager.md 177 -> 179 for delta 20260921 phase 2a-16 (bead 332y.6, owner
  // decision Q14 a, raised just enough): the Manager gains two lines for the
  // plugin's BM-FALLBACK notice — tell the user in one line, create no agent,
  // and follow the replacement Worker once switched. No paragraph of manager.md
  // has wrap slack left.
  //
  // worker.md 397 -> 402 for delta 20260921 phase 2a-16 (bead 332y.8, owner
  // decision Q14 a, raised just enough): a replacement Worker starts from the
  // plugin's BM-HANDOVER, and the five-line paragraph that tells it to continue
  // the request — read git status and git diff first, revert nothing, keep the
  // review budget — sits with the other plugin messages under "Reporting". No
  // paragraph of worker.md has wrap slack left.
  //
  // worker.md 402 -> 403 for bead 332y.11 (same decision): one line for the
  // plugin's BM-RESUME notice after a usage reset; re-wrapping it into the
  // handover paragraph saves no line.
  //
  // worker.md 403 -> 408 for delta 20260921 phase 2a-17 (bead fnnc.1, same
  // decision): a four-line paragraph under "Reviewing" — a Reviewer that ends
  // on a provider error is not a review, create no other one, wait for the
  // plugin's BM-FALLBACK — plus its blank line. It is its own topic, so it is
  // not folded into the paragraph before it.
  //
  // worker.md 408 -> 409 for bead fnnc.5 (same decision): the BM-SETTINGS
  // line now also covers a replacement Manager's id and takes two lines.
  //
  // manager.md 179 -> 182 for bead fnnc.4 (same decision): three lines for a
  // replacement Manager starting from BM-HANDOVER role manager. Re-wrapping
  // the plugin-message lines would split the BM-TOOLS sentence that
  // test/tools-check.test.ts pins on one line.
  // worker.md 409 -> 412 for bead bm-tier-reviewfindings-mau-q5oy (diagnosis
  // 2026-09-23, fault L2): three lines saying that `tier` and
  // `reviewFindingsOpen` accept a short note, and that `reviewFindingsOpen`
  // still has to open with `none` or `b<n>:`. The template two lines below
  // teaches the shape but not the allowance, and 9 of 87 real reports tripped
  // on exactly that gap. Raised rather than trimmed: the alternative was
  // dropping the "b4 is still running is not a value" half, which is the one
  // shape the checker still rejects and therefore the one worth saying.
  // worker.md 412 -> 415 for bead bm-format-khong-keo-questions-aqxs (diagnosis
  // 2026-09-23, fault L1): BM-FORMAT now has two endings, and a Worker that
  // always re-sends would put its BM-QUESTIONS in front of the user a second
  // time — the cause of all four repeated question cards that day. The
  // paragraph has to name the fork and say why, or the notice's own "do NOT
  // send this block again" line argues with the role file.
  // manager.md 182 -> 185 for bead bm-so-hoi-dap-tb4m.3 (design delta
  // 20260924-qa-ledger §5): three lines for the plugin's BM-ANSWERED notice.
  // A card answer goes straight to the Worker, so without them the Manager
  // kept telling the user an answered question was open and relayed it again
  // (2026-09-22T17:11Z, 2026-09-23T05:58Z). The "reported again" rule of the
  // `blocked` bullet took its new clause within its own lines.
  // worker.md 415 -> 418 for bead bm-so-hoi-dap-tb4m.4 (design delta
  // 20260924-qa-ledger §6): the Worker is now the only side that asks about
  // reviews beyond the budget, and a yes covers what the user said it covers.
  // Without the second half each extra review re-asked the same decision
  // (project-b req-20260923T122743Z Q6 then Q8). Two lines appended to
  // the paragraph that already says "ask the user".
  // worker.md 418 -> 422 for bead bm-so-hoi-dap-tb4m.5 (design delta
  // 20260924-qa-ledger §7): an option that hands the user an action outside
  // the chat must mean "done" when chosen. "I will run it, then tell you"
  // delivered the answer before the action, and the Worker asked the same
  // thing again under a new number (paseo-bm req-20260923T063441Z Q8 -> Q9,
  // Q16 -> Q17 -> Q18). Five lines appended to the paragraph on what makes a
  // question answerable, where the rule belongs.
  // worker.md 422 -> 424 for bead bm-so-hoi-dap-tb4m.6 (design delta
  // 20260924-qa-ledger §8): BM-HANDOVER now carries the request's questions
  // and answers, and a replacement Worker must treat the answered ones as
  // settled or it asks the user everything again. Two lines in the handover
  // paragraph.
  // worker.md 424 -> 425 for the same bead (design delta 20260924-qa-ledger
  // §3.4): the plugin counts a number with any answer as answered, so a
  // question the answer did not settle must come back under a NEW number.
  // Replaying the real traces found one Worker that re-asked Q3 under Q3
  // (wks_project_c, 2026-09-21T06:59:56Z); the pill would have hidden it.
  // worker.md 425 -> 406 for bead bm-worker-autonomy-895l.1 (design delta
  // 20260924-worker-autonomy §3): one loop instead of three tier branches, a
  // consequence definition instead of the ordered list and its examples, and
  // "decide what you can undo, ask four things" instead of eight triggers and
  // three fixed moments. Lowered to the measured 405 + 1 so the savings stay.
  it.each([
    // Owner decisions P2 (2026-09-24): worker.md 356 -> 371 for the rule that a
    // request asking only for information gets no bead and no Reviewer, the
    // `decided` field, and the review fixes (named notices, read-only helpers,
    // the review-budget question); manager.md 149 -> 152 for reading the
    // Worker's activity and the named notices. Measured + 1.
    // Design delta 20260924-instruction-quality: worker.md 406 -> 356 (the
    // plugin messages speak for themselves, the worked bead and the criteria
    // table left, rules gained their reasons); reviewer.md 164 -> 170 because
    // the criteria table now lives only there (it drifted while worker.md held
    // a copy); manager.md 177 -> 149 (no size guess, no skill-directory rules,
    // no per-message rules). Each is the measured length + 1.
    ["worker.md", worker, 374],
    ["reviewer.md", reviewer, 170],
    // manager.md 185 -> 177 for bead bm-worker-autonomy-895l.2 (design delta
    // 20260924-worker-autonomy §4): no ordered size rule, no Large
    // confirmation, no skills-per-tier check. Measured 176 + 1.
    ["manager.md", manager, 152],
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

  it("states the precedence between this file, the skills and the repository's own instructions", () => {
    rule(W, "skills say how", /[Ss]kills say how/);
    rule(W, "the repository's AGENTS.md says how code is written there", /repository's own `AGENTS\.md` or `CLAUDE\.md` says how code is written there/);
    rule(W, "this file decides the limits, the budget, reporting, asking and scope", /\*\*this file\s+decides\*\*/);
    rule(W, "and why", /neither of those knows what you are allowed to do here/);
  });
});

describe("worker.md — the workflow", () => {
  // Design delta 20260924-worker-autonomy §3 (owner, 2026-09-24): the tier is
  // the model's own judgement of consequences. The ordered "first match wins"
  // list, its examples, the skills-per-tier row, the three branches and the
  // Large confirmation are gone on purpose: Workers cited "rule 1" to call
  // internal changes Large (209 Large reports against 74 Medium).
  it("sizes by consequence, in the model's own judgement", () => {
    rule(W, "consequences, not the size of the diff", /Judge the consequences, not the size of the diff/);
    rule(W, "bead count is never evidence", /number of beads is never\s+evidence/i);
    rule(W, "Large is what is hard to undo or reaches outside the repository", /\*\*Large\*\* — hard to undo, or it reaches people outside this repository/);
    rule(W, "Small needs no document", /\*\*Small\*\* — one clear change that needs no document/);
    rule(
      W,
      "a tier or size the user sets wins",
      /(override|sets?)[^.]{0,50}(tier|size)|(tier|size)[^.]{0,50}(the user|Manager)[^.]{0,30}(set|override)/i,
    );
    expect(W).not.toMatch(/FIRST match wins/);
    expect(W).not.toMatch(/Examples: API response wording/);
  });

  it("ties reviews, not documents or skills, to the tier, and never waits for a confirmation", () => {
    expect(W).toMatch(/\*\*Review calls per request\*\* \| \*\*2\*\* \| \*\*2\*\* \| \*\*4\*\*/);
    rule(W, "Small writes no new document file", /no new document file/);
    rule(W, "documents only where the change needs them", /\*\*Write documents only where the change needs them\*\*/);
    expect(W).not.toMatch(/\| Skills/);
    expect(W).not.toMatch(/ask the user to confirm and wait/);
    rule(W, "Large does not wait after b1", /there is no confirmation to wait for/);
  });

  it("holds the whole job in one loop, the same at every tier", () => {
    const loop = between(W, "One loop, from the request", "## How big is this");
    order(
      loop,
      "the loop",
      "**Size the request**",
      "`received`",
      "**Ask once, only what you cannot decide or look up**",
      "**Write documents only where the change needs them**",
      "**Large only:**",
      "Implement the request's beads one at a time",
      "Review the implementation as one batch",
      "`finished` with your decisions",
    );
    for (const step of ["`reviewing-plan`", "`plan-ready-for-beads`", "`converting-plan-to-beads`", "`polishing-beads`", "write the beads by hand", "one short bead"]) {
      expect(loop, step).toContain(step);
    }
    verbatim(loop, "`Plan-ready: PASS — <date>`");
    expect(loop).not.toMatch(/\*\*Medium\*\* —/);
  });

  it("treats skill passes as its own work, with a cadence per skill", () => {
    rule(W, "skill passes are not review calls", /Skill passes are your own work, not review calls/);
    rule(W, "reviewing-plan and converting-plan-to-beads run once per plan", /`reviewing-plan` and\s+`converting-plan-to-beads` once per plan/);
    rule(W, "polishing-beads runs once per wave", /`polishing-beads` once per wave/);
  });

  // Design delta 20260924-instruction-quality §2.4: every read stays in the
  // context and is read again at each later step (the Worker's biggest cost).
  it("keeps its context small", () => {
    rule(W, "keeps its context small, and says why", /\*\*Keep your context small\.\*\* Everything you read stays in your context and is\s+read again at every later step/);
    rule(W, "never prints a whole large file or log", /never print a whole large file, log or command\s+output/);
  });
  // Design delta 20260924-instruction-quality §2: the 35-line worked bead left
  // the always-loaded file; the checklist lives in `converting-plan-to-beads`.
  // What a hand-written bead must carry stays here, with why.
  it("states the leaf contract and sizes beads by outcome", () => {
    rule(W, "a hand-written bead carries the core of the leaf contract", /needs its Objective,\s+Scope \(in and out\), Acceptance Criteria, a \*\*Primary Proof\*\* named before you\s+start and its \*\*Reversibility\*\*/);
    rule(W, "a Large request's hand-written beads follow the converter's checklist", /and so do a Large request's beads written by\s+hand, because its `b1` review applies that checklist/);
    rule(W, "the plan's leaves follow the converter's checklist", /`converting-plan-to-beads`\s+`reference\/leaf-bead-checklist\.md`/);
    rule(W, "Primary Proof and Reversibility say what they buy", /prove\s+itself and undo itself/);
    rule(W, "one leaf is one outcome", /One leaf is one outcome/);
    rule(W, "size is never judged by counts", /never judge size by file, line or bead\s+counts/);
    verbatim(W, "`## Acceptance Criteria`", "`## Success Criteria`", "`br lint -s all`");
    rule(W, "an existing heading is never dropped", /(never drop|never goes away|never removes?)[^.]{0,40}heading|heading[^.]{0,40}(never goes away|is never dropped)/i);
    rule(W, "every new bead has a Provenance section", /`## Provenance`/);
    rule(W, "and it names the request id and the request itself", /the `requestId` and the\s+user's request in one quoted line/i);
  });
  it("labels every bead with feature:<slug> and picks the closest of several matches itself", () => {
    verbatim(W, "`feature:<slug>`", "`br list --label feature:<slug> --json`", "`feature:hoa-don`");
    // Design delta 20260924-instruction-quality §2.5: which duplicate to update can be undone.
    rule(W, "several matches: update the closest and record it", /one or more that overlap → update the closest and say why in the bead\s+\(picking one of several goes on your `decided` line\)/);
    expect(W).not.toMatch(/more than one → stop and ask/i);
  });
  it("implements one bead at a time and closes each one on its own evidence", () => {
    rule(W, "only one bead in progress", /only \*\*one\*\* bead `in_progress`/i);
    rule(W, "only this request's beads", /Never pick up other ready beads|only (on )?this request's beads/i);
    // Design delta 20260924-instruction-quality §2.3: the rule keeps its reason, and read-only helpers are allowed.
    rule(W, "never two agents editing at once, and why", /never let two agents edit at once, because the working\s+tree and the bead states would race/);
    rule(W, "read-only helper agents are fine, inside the limits", /helper agents that only read files in\s+this workspace — no network, never through `create_agent` — are fine/);
    order(
      W,
      "per-bead cycle",
      "`br update <id> --status in_progress`",
      "run the check that proves it",
      '`br close <id> --reason "<the evidence:',
    );
    rule(W, "no build command is not a reason to stop", /no build or test command is not a reason to stop/i);
    rule(W, "git status is read once before the first write", /`git status` once before your first write/);
    rule(W, "the cheapest check that proves it", /cheapest (direct )?check/);
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

  // Design delta 20260924-worker-autonomy §3: 78% of 285 answered questions
  // took the Worker's own recommendation and 31% were about the process
  // itself, so the Worker decides what it can undo and asks for four things.
  it("decides what it can undo, records it, and asks only four things, once and early", () => {
    rule(W, "decides what it can undo", /\*\*Decide what you can undo\.\*\*/);
    rule(W, "records each decision for the user to overturn", /record the ones the\s+user may care about on your report's `decided` line \(Reporting\), so they can\s+overturn them/);
    rule(W, "looks before it asks", /\*\*Look before you ask\.\*\*/);
    rule(W, "asks about the environment only what it cannot read", /a\s+fact about the environment you cannot read yourself/);
    rule(W, "an existing bead's acceptance criteria are an approved decision", /changing an\s+existing bead's acceptance criteria/);
    rule(W, "asks only for four things", /\*\*Ask only for these four\*\*/);
    rule(W, "asks in one round right after sizing", /\*\*Ask once, early\.\*\* Every question you can already see goes into one round/);
    rule(W, "asks when stuck", /\*\*Being stuck\*\* — the same error a third time after three different fixes/);
    expect(W).not.toMatch(/fixed moments/);
    expect(W).not.toMatch(/on intake before any document/i);
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
    ] as const) {
      rule(W, `stop-and-ask trigger: ${name}`, pattern);
    }
    // The single-question rule of delta 20260916-review-budget is gone.
    expect(W).not.toContain("Ask ONE clear question");
  });

  it("gets one review and one re-review per batch, and never fixes non-blocking findings", () => {
    rule(W, "a review is a message to a Reviewer agent", /review happens only when you send a message to a Reviewer|review happens only when you send a Reviewer agent a message/i);
    rule(W, "one review, then at most one re-review", /one review and, only if blocking findings remain, one re-review/i);
    // Design delta 20260924-worker-autonomy: Small no longer has the one-review
    // exception that ended in a question to the user; documents are reviewed
    // before implementing only for Large or on request.
    rule(W, "the same at every tier", /one re-review\s+— at every tier/);
    rule(W, "what was written is reviewed before implementing only for Large or on request", /Review what you\s+wrote before implementing only for a Large request or when the user asks/);
    rule(W, "a review the user asks for is its own yes", /a\s+review the user asks for is its own yes to the calls it takes/);
    expect(W).not.toMatch(/Small request is the exception/);
    rule(W, "a batch keeps its id", /keeps its `batchId`/);
    // Design delta 20260924-instruction-quality §2.3: the rule now says why, and lets a slip in the Worker's own work be fixed.
    rule(W, "non-blocking findings are suggestions, with the reason", /Non-blocking findings are suggestions: fix one only when it is a\s+slip in what you wrote for this request and needs no new review/);
    rule(W, "and why the rest are not fixed", /fixing them grows the scope and would need\s+another review/);
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
    // Design delta 20260924-instruction-quality §2.2: the criteria live in
    // reviewer.md only; the Worker names the stage, chosen by what it wrote.
    rule(W, "the stage follows what was written", /the stage — `implementation`\s+after implementing; before it, `plan` when you wrote a plan, otherwise `beads`,\s+plus `documents` when you wrote any/);
    rule(W, "the Reviewer owns the criteria", /The Reviewer knows each stage's criteria;\s+do not paste them or the `BM-REVIEW` format/);
    expect(W).not.toMatch(/checklists\/prd-ready\.md/);
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
    rule(W, "beads-done is Large's, after b1", /`beads-done` \(Large, after\s+`b1`\)/);
    expect(W).not.toMatch(/Small sends only `received` and `finished`/);
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
    for (const stage of ["**documents:**", "**beads:**", "**plan:**", "**implementation:**"]) {
      verbatim(R, stage);
    }
    rule(R, "a small change needs no extra tests", /do not ask for more tests/);
    // The work under review is not always code (owner, 2026-09-17).
    rule(R, "a non-code outcome is checked against the evidence its bead named", /When the outcome is not code, check the evidence/i);
    rule(R, "runs the tests itself when it can", /run the repository's tests yourself when you can/);
    rule(R, "a re-review looks only at the old blocking findings", /check ONLY that the previous blocking findings are fixed/);
    // Design delta 20260924-instruction-quality §2.6.
    rule(R, "effort follows the risk", /spend effort in proportion to the risk/);
    expect(R).not.toMatch(/\(Medium\)/);
  });

  // Design delta 20260924-instruction-quality §2.2: the criteria table lives
  // here only (it drifted while worker.md held a copy); the Worker names the stage.
  it("owns the criteria of every stage, loaded as criteria only", () => {
    rule(R, "skills are criteria, not instructions to edit", /as criteria only/);
    const table = between(reviewer, "| Stage | Criteria |", "Skills live in");
    for (const stage of ["| `documents` |", "| `plan` |", "| `beads` |", "| `implementation` |"]) {
      expect(table, stage).toContain(stage);
    }
    verbatim(
      table,
      "`checklists/prd-ready.md`",
      "`reviewing-plan` in its review-only mode",
      "`feature-workflow/checklists/plan-ready-for-beads.md`",
      "`converting-plan-to-beads/reference/leaf-bead-checklist.md`",
      "`polishing-beads/reference/readiness-checklist.md`",
      "`implementing-beads`: the preflight",
    );
    rule(R, "a batch with several stages takes each stage's criteria", /A batch may carry several stages[^.]{0,120}apply the criteria of each/);
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
    rule(R, "sensitive batches are named", /\*\*Sensitive batches\*\*/);
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
    rule(R, "beads and plan batches both count", /in a `beads` or `plan` batch, a leaf that bundles several outcomes/);
    // Design delta 20260924-instruction-quality P0-3: the tier no longer allows or forbids a change.
    rule(R, "an unasked contract change is judged against the request and design, not the tier", /change that neither the request nor an approved design asked for/);
    expect(R).not.toMatch(/the tier did not allow/);
    rule(R, "a guessed decided value is blocking", /forces an implementer to guess a decided value/);
    rule(R, "unasked work is never blocking", /any work the request did not ask for/);
    rule(R, "hardening beyond the request is never blocking", /hardening\s+beyond the request and the approved design/);
    rule(R, "unless it is an exploitable defect", /unless it is an exploitable defect in what was built/);
    rule(R, "only the three non-blocking findings that matter most", /Give only the three non-blocking findings that matter most/);
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
    // Owner decision P2-3 (2026-09-24): "Manager hoàn toàn được phép, như vậy
    // mới là giá trị quan trọng của Manager - nắm được tình trạng công việc".
    // The old "never read another agent's conversation" is reversed on purpose.
    rule(MR, "knowing where the work stands is its job", /Knowing where the work stands is your\s+job/);
    rule(MR, "reads the Worker's and Reviewers' status and activity", /read a Worker's or its\s+Reviewers' status and activity \(`get_agent_status`, `get_agent_activity`\)/);
    rule(MR, "the plugin's own notices count as a source", /the reports and the plugin's notices/);
    rule(MR, "says what it saw and how old it is", /Say what you saw and how old it is/);
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
    // Owner decision P2-3 lets it read other agents' activity: a secret seen there is still never printed.
    rule(MR, "a secret seen in another agent's activity is never printed", /NEVER READ OR PRINT SECRETS\*\* — the environment, or one seen in an agent's\s+activity/);
  });

  it("does not carry the Worker's own limits (owner decision, 2026-09-16)", () => {
    expect(M).not.toContain("NEVER commit, push, open pull requests");
  });
});

describe("manager.md — how it runs a request", () => {
  it("delegates before it looks anything up", () => {
    order(M, "delegate first", "2. **Delegate now", "4. **Confirm to the user");
    rule(M, "no lookups before delegating", /Do not search tools or list\s+agents first/);
  });
  // Design delta 20260924-instruction-quality §3: the Worker sizes; a Manager
  // guess only anchored it. A size the user states is still passed on.
  it("leaves the size to the Worker and passes on only a size the user stated", () => {
    rule(M, "the Worker sizes", /The Worker sizes it/);
    rule(M, "a stated size is passed on", /a size\s+only if the user stated one/);
    expect(M).not.toMatch(/guess the size|size guess/i);
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
      /If it names no Worker mode, the creation fails with\s+Paseo's own list of modes, which you report/,
    );
    expect(M).not.toMatch(/inspect_provider/);
    expect(M).not.toMatch(/bypassPermissions|full-access|colorTier/);
    rule(M, "the Worker's own instructions are not repeated", /The Worker already has its own instructions/);
  });

  // Design delta 20260924-instruction-quality §3, PRD delta REQ-035a: the
  // plugin checks the skills and writes the result into the Runtime facts.
  it("tells the user about missing skills from its Runtime facts, once, and never blocks", () => {
    rule(M, "missing skills come from the Runtime facts", /If your `## Runtime facts` name missing\s+Worker skills, add that the first time you confirm a Worker in this chat/);
    expect(M).not.toMatch(/~\/\.codex\/skills|Then check skills/);
  });
  it("answers a `received` report with one line", () => {
    rule(M, "received is acknowledged in one line", /\*\*`received`:\*\* one line/);
    rule(M, "and nothing more is due until the Worker speaks again", /Nothing else is due until it asks or\s+finishes/i);
  });

  it("only reports a budget notice", () => {
    // Owner decision Q17: the plugin counts. Design delta 20260924-qa-ledger §6
    // replaces Q21's "the Manager asks": the Worker asks before any review
    // beyond its budget, so the Manager tells the user in one line and does
    // not ask the same thing again. The Manager carries no budget table.
    expect(M).not.toMatch(/\*\*Total review calls per `requestId`\*\*/);
    // Design delta 20260924-instruction-quality §2.1: the notice says it all; manager.md only hands BM- messages to themselves.
    expect(M).not.toMatch(/ask the user whether to\s+continue or to cancel/i);
    const notice = budgetNotice({ requestId: "req-X", tier: "Large", calls: 5, budget: 4, managerAgentId: "m" });
    expect(notice).toContain("do not ask the user about it");
    expect(notice).toContain("Do not cancel on this notice alone");
    rule(M, "a budget notice still allows a cancel the user asks for", /including after a budget notice/);
    // The Worker is the one that asks, and a yes covers what the user said.
    rule(W, "the Worker asks before a review past its budget", /Before a review call past the table's\s+number, send `blocked` and ask — unless the user asked for that review or for\s+the changes it covers/);
    rule(W, "the Worker alone asks about it", /You are the only one who asks about it/);
    rule(W, "a yes covers what the user said it covers", /a yes covers what the user said it covers \("one more", "until it is clean"\): do not ask again for a call inside it/);
    expect(M).not.toMatch(/If a limit is exceeded without permission: cancel/);
    // Design delta 20260924-worker-autonomy §4: skills are no longer required per tier.
    expect(M).not.toMatch(/a skill its tier requires/);
    expect(M).not.toMatch(/Small 1,\s+Medium 4, Large 6/);
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
    rule(M, "progress is read from the Worker's activity, never asked of it", /never message the Worker to ask for\s+progress — read its activity instead/i);
    rule(M, "progress questions are answered from what it saw, with its age", /answer from what you saw, with how old it is/i);
    rule(M, "two sources that disagree are both named", /which source said what/i);
    rule(M, "progress is never invented", /never invent progress/i);
  });

  it("keeps its own right to cancel a stuck Worker (REQ-020d), which Q21 did not change", () => {
    rule(M, "a stuck or off-course Worker is cancelled and the user told why", /stuck or off course:\*\* cancel its run, tell the user why/);
  });

  it("reports each Worker phase the way the user needs it", () => {
    // Design delta 20260924-worker-autonomy §4: Large no longer waits for a confirmation.
    rule(M, "beads-done is one line and waits for nothing", /\*\*`beads-done`:\*\* one line[^.]{0,120}it waits for no confirmation/);
    rule(M, "finished counts the Worker's own decisions, which the user can overturn", /how many choices the report's `decided` line lists —\s+made by the Worker on its own, any of which the user can overturn/);
    expect(M).not.toMatch(/waiting for the\s+user's confirmation/);
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
    rule(
      M,
      "a Worker that reported again is not answered again",
      /reported again has had its answers[^.]{0,40}relay nothing more/,
      // Design delta 20260924-qa-ledger §5.4 adds the BM-ANSWERED case to the same rule.
      /reported again, or whose questions a `BM-ANSWERED` closed, has had its answers: relay nothing more/,
    );
    // Delta 20260918d: the card lists the suggestions; the Manager counts them
    // and still asks the user which, if any, becomes new work.
    rule(M, "suggestions are counted and put to the user", /how many `Suggestion \(not done\)` items, and ask which\s+suggestion, if any, becomes new work — the user decides/);
    // The Manager can only relay them because the Worker puts them in `blockers`.
    // Design delta 20260924-instruction-quality P0-1: one `blockers` line, or the format check rejects the report.
    // Owner decision P2-2: decisions have their own `decided` field; suggestions stay in `blockers`.
    rule(W, "the Worker puts its suggestions in blockers", /goes in `blockers`, after `none` when nothing is blocking:\s+`none\. Suggestion \(not done\): …`/i);
    rule(W, "and its own decisions on the decided line", /`decided` holds the choices you made on your own that\s+the user may want to overturn, `none` when there are none/);
    verbatim(worker, "decided: <choice> — <why>; <choice> — <why>\nblockers:");
    rule(W, "every field is one line", /Every field is one line\./);
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

  it("shows worked examples as examples, not as lists of rules (§4.8)", () => {
    const workerBlocks = fenced(worker);
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

// Design delta 20260924-instruction-quality §2.1: every BM- message says what
// the receiver does, so worker.md and manager.md carry one line for all of them
// and the per-message rules are pinned on the messages themselves.
describe("plugin messages carry their own instructions", () => {
  it("worker.md and manager.md hand every BM- message to the message itself", () => {
    // Review of this delta (blocking): a catch-all "BM-" also caught BM-REPORT,
    // BM-NEW-REQUEST and the user's BM-ANSWERS; each file names its notices.
    rule(W, "the plugin's notices are named and say what to do", /The plugin's notices — messages that start with `BM-FORMAT`, `BM-SETTINGS`,\s+`BM-HANDOVER`, `BM-RESUME` or `BM-FALLBACK` — come from the plugin, not the\s+user: each says what to do, so do exactly that/);
    rule(W, "the user's BM-ANSWERS is not a notice", /A `BM-ANSWERS` block is the user's answer, not a notice\./);
    rule(M, "the plugin's notices are named and say what to do", /The plugin's notices — messages that start with `BM-FORMAT`, `BM-BUDGET`,\s+`BM-TOOLS`, `BM-SETTINGS`, `BM-FALLBACK`, `BM-RESUME`, `BM-ANSWERED` or\s+`BM-HANDOVER` — come from the plugin, not the user or the Worker: each says what to do/);
    rule(M, "a Worker report and the user's new-request flag are not notices", /A Worker's\s+`BM-REPORT` and the user's `BM-NEW-REQUEST` are not notices\./);
    for (const [name, text] of [["worker.md", W], ["manager.md", M]] as const) {
      expect(text, name).not.toMatch(/`BM-(SETTINGS|RESUME|FALLBACK|TOOLS|ANSWERED)` \(plugin\)/);
    }
  });

  it("each notice says what its receiver does", () => {
    expect(formatNotice("BM-REPORT", "req-X", ["x"])).toMatch(/Send the whole corrected block again[^\n]*Do not mention this notice to the user\.$/);
    expect(formatNotice("BM-REPORT", "req-X", ["x"], true)).toMatch(/Do NOT send this block again[^\n]*Do not mention this notice to the user\.$/);
    expect(formatNotice("BM-ANSWERS", "req-X", ["x"])).toMatch(/Send the whole corrected block again/);
    for (const part of [
      "never revert it",
      "Reopen a closed bead only if a review blocks it",
      "Continue the review budget from `reviewCalls`",
      "never ask an answered one again",
      "number new ones after the highest listed (from Q100 when it reads `unknown`)",
      "send `received` to `managerAgentId`",
    ]) {
      expect(WORKER_CLOSING, part).toContain(part);
    }
    expect(settingsNotice("Worker mode: `x`")).toMatch(/replaces the matching line[\s\S]*Do not reply to this message; carry on/);
    expect(managerIdNotice("m-2")).toContain("send every BM-REPORT to this agent from now on");
    expect(RESUME_NOTICE).toContain("Continue from where you stopped; do not redo finished work.");
    expect(toolsNotice("w", "pi")).toContain("Tell the user in one line; do not create another Worker");
  });

  // Delta 20260921 §4.5.1 (REQ-066 b): a Reviewer stopped by its provider plan
  // is replaced through its Worker, on the plugin's instructions — before any
  // notice arrives, so this one stays in worker.md.
  it("worker.md waits for BM-FALLBACK when a Reviewer ends on a provider error", () => {
    expect(between(worker, "## Reviewing", "## Reporting").replace(/\s+/g, " ")).toContain(
      "A Reviewer of yours that ends on a provider error (usage limit, credit or billing, login, provider unavailable) is not a review: create no other Reviewer, end your turn without a report, and wait — the plugin asks the user with a card, then sends you `BM-FALLBACK`.",
    );
  });

  it("reviewer.md keeps its BM-FORMAT rule, next to its answer", () => {
    expect(between(reviewer, "## Your answer", "## Stop").replace(/\s+/g, " ")).toContain(
      "A message that starts with `BM-FORMAT` is the plugin's: answer with the whole corrected `BM-REVIEW` block only; do not review again.",
    );
  });
});

describe("manager.md closes what BM-ANSWERED reports (design delta 20260924-qa-ledger §5.4)", () => {
  it("drops the questions, relays nothing, and tells the user in one line", () => {
    expect(manager).toMatch(/or whose\n {2}questions a `BM-ANSWERED` closed, has had its answers: relay nothing more\./);
  });
});

describe("worker.md: an action handed to the user is answered once it is done (design delta 20260924-qa-ledger §7)", () => {
  it("writes such an option as done, never as a promise, and does not re-ask it under a new number", () => {
    rule(W, "choosing the option means the action is done", /An option that needs the user to act outside the chat \([^)]*\) is written so that choosing it means it is done/);
    rule(W, "never a promise to report back", /never "I will do X, then tell you"/);
    // Review finding 4: "wait" named no channel and pulled against "an answer
    // closes its number"; `blocked` must carry questions (bm-format.ts), so a
    // failed check is a new question under a new number, said as such.
    rule(W, "a failed check after it is asked under a new number, saying what was seen", /If your check still fails after such an answer, it did not settle the question: say in one line what you saw and ask under a new number\./);
  });
});

describe("worker.md: an answered number is closed (design delta 20260924-qa-ledger §3.4)", () => {
  it("asks what an answer left open under a new number", () => {
    rule(W, "an answer closes its number even when it does not settle it", /An answer that does not settle its question still closes that number: ask what is left under a new number, saying why\./);
  });
});

// Owner decision P2-1 (2026-09-24): "Việc tra cứu thì không được phép có bead
// và reviewer" — forbidden, not merely optional.
describe("worker.md: a request that only asks for information", () => {
  it("never gets a bead, a Reviewer or a review call, and skips straight to finished", () => {
    rule(W, "skips the change steps", /A request that only asks for information\s+never gets a bead, a Reviewer or a review call: answer it \(below\), send\s+`finished`, and skip steps 3–6\./);
    rule(W, "never a bead or a Reviewer, no document unless asked", /changes nothing, so it never gets a bead or a\s+Reviewer, and no document unless the user asks for one/);
    rule(W, "the answer goes in the chat and blockers stays none", /give it with its sources in your chat\. In the `finished` report `blockers`\s+stays `none`/);
  });
});
