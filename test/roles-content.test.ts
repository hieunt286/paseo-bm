import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { budgetNotice } from "../plugin/server/review-budget";
import { formatNotice } from "../plugin/server/format-check";
import { WORKER_CLOSING } from "../plugin/server/fallback-handover";
import { managerIdNotice, settingsNotice } from "../plugin/server/settings-notices";
import { RESUME_NOTICE } from "../plugin/server/fallback-wait";
import { toolsNotice } from "../plugin/server/tools-check";
import { MANAGER_INSTRUCTIONS } from "../plugin/server/manager-instructions";
import { WORKER_INSTRUCTIONS } from "../plugin/server/worker-instructions";
import { REVIEWER_INSTRUCTIONS } from "../plugin/server/reviewer-instructions";
import { ORCHESTRATOR_INSTRUCTIONS } from "../plugin/server/orchestrator-instructions";
import { toolFacesFor } from "../plugin/shared/bm-tools";
import { parseQuestions } from "../plugin/shared/bm-questions";
import { CONFIRM_EFFECTS, EFFECTS } from "../plugin/shared/decisions";
import { eventLineOf, type BmEvent } from "../plugin/server/event-bus";

/**
 * What the four role files must carry — the contract of the rewrite from zero
 * (autonomy design §A.11, PRD REQ-117, bead bm-autonomy-phase1a-odkl.12).
 *
 * Two layers, as before the rewrite (design delta 20260917b-simplify-roles §4.6):
 *
 * 1. VERBATIM — only what something outside the file reads: the fallback
 *    `BM-REPORT`, `BM-QUESTIONS` and `BM-REVIEW` blocks, the stop line, label
 *    and provider names, the budget numbers.
 * 2. BY INTENT — one assertion per duty, matched on a few interchangeable
 *    phrasings over the whole file: rewording stays green, deleting goes red.
 *
 * And one layer the rewrite adds: the RETIRED mechanisms (answer letters,
 * relays, `BM-ANSWERED`, `BM-STALL`, `BM-EVENT`, proposals, the gate folklore)
 * must not come back. Every old rule's destination is recorded in
 * docs/archive/operations/paseo-bm-roles-rewrite-20260929.md.
 */
const read = (file: string) => readFileSync(fileURLToPath(new URL(`../plugin/roles/${file}`, import.meta.url)), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

const manager = read("manager.md");
const worker = read("worker.md");
const reviewer = read("reviewer.md");
const orchestrator = read("orchestrator.md");
const M = flat(manager);
const W = flat(worker);
const R = flat(reviewer);
const O = flat(orchestrator);

const FILES = [
  ["manager.md", manager],
  ["worker.md", worker],
  ["reviewer.md", reviewer],
  ["orchestrator.md", orchestrator],
] as const;

type Pattern = string | RegExp;
const hit = (text: string, p: Pattern) => (typeof p === "string" ? text.includes(p) : p.test(text));

/** The file states this duty, however it is worded: one phrasing is enough. */
function rule(text: string, name: string, ...phrasings: Pattern[]): void {
  expect(phrasings.some((p) => hit(text, p)), `rule missing: ${name}`).toBe(true);
}

/** The file pins this exactly, because something else parses it. */
function verbatim(text: string, ...phrases: string[]): void {
  for (const phrase of phrases) expect(text, phrase).toContain(phrase);
}

/** The lines of the `## RULES` block, up to the next `## ` heading. */
function rulesBlock(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf("## RULES");
  expect(start, "## RULES").toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start, end === -1 ? undefined : end);
}

/** The fenced block that starts with `marker`, without its fences. */
function fenced(text: string, marker: string): string {
  const start = text.indexOf("```\n" + marker);
  expect(start, marker).toBeGreaterThanOrEqual(0);
  const body = start + 4;
  return text.slice(body, text.indexOf("\n```", body));
}

const MR = flat(rulesBlock(manager).join("\n"));
const WR = flat(rulesBlock(worker).join("\n"));
const RR = flat(rulesBlock(reviewer).join("\n"));
const OR = flat(rulesBlock(orchestrator).join("\n"));

describe("budgets (design §A.11)", () => {
  // Rewritten from zero on 2026-09-29: 201 / 400 / 167 / 181 lines before.
  it.each([
    ["manager.md", manager, 120],
    ["worker.md", worker, 250],
    ["reviewer.md", reviewer, 120],
    ["orchestrator.md", orchestrator, 100],
  ])("%s stays within %i lines", (_name, text, limit) => {
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n").length - 1).toBeLessThanOrEqual(limit);
  });

  // Owner, 2026-09-17: limits about CLASSES of action, not a ban per incident.
  // A new limit has to replace one of these, or change this number on purpose.
  it.each([
    ["manager.md", manager, 5, 20],
    ["worker.md", worker, 5, 28],
    ["reviewer.md", reviewer, 4, 14],
    ["orchestrator.md", orchestrator, 3, 18],
  ])("%s opens with a RULES block of exactly %i limits in at most %i lines", (name, text, limits, lines) => {
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    expect(headings[0], name).toBe("## RULES");
    const block = rulesBlock(text);
    expect(block.filter((line) => /^\d+\. \*\*/.test(line)).length, `${name}: numbered limits`).toBe(limits);
    expect(block.length, `${name}: RULES block length`).toBeLessThanOrEqual(lines);
    expect(block.filter((line) => /^[-*] /.test(line)).length, `${name}: stray bullets`).toBe(0);
    expect(block.join("\n")).toMatch(/about CLASSES of action rather than lists of commands/);
  });

  it.each(FILES)("%s has no placeholder left", (_name, text) => {
    expect(text).not.toMatch(/TODO|TBD|\[fill/i);
  });

  it.each(FILES)("%s is embedded byte for byte (run `npm run build` after editing the markdown)", (name, text) => {
    const embedded = { "manager.md": MANAGER_INSTRUCTIONS, "worker.md": WORKER_INSTRUCTIONS, "reviewer.md": REVIEWER_INSTRUCTIONS, "orchestrator.md": ORCHESTRATOR_INSTRUCTIONS }[name];
    expect(embedded).toBe(text);
  });
});

describe("retired mechanisms stay retired (ADR-017, design §A.14)", () => {
  it.each(FILES)("%s names no retired notice, proposal, relay or gate", (name, text) => {
    const t = flat(text);
    const retired: Array<[string, RegExp]> = [
      ["BM-ANSWERED", /BM-ANSWERED/],
      ["BM-STALL", /BM-STALL/],
      ["BM-EVENT (singular)", /BM-EVENT(?!S)/],
      ["proposals", /propos(e|al)|bm_propose_command|dismiss/i],
      ["waiting pills and answer marks", /waiting pill|mark(ed)? as answered|answer mark/i],
      ["the Manager's answer letters", /`A6 a|A · <name>|under a letter/],
      ["relays", /\brelay/i],
      // The plan-ready-for-beads gate is a skill's; the Orchestrator's regex gate is folklore.
      ["gate folklore", /the gate\b|decision gate|Allow…|big decision/i],
      ["retired Autopilot wake-ups", /autopilot-on|manager-turn|waiting-user/],
    ];
    const found = retired.filter(([, pattern]) => pattern.test(t)).map(([label, pattern]) => `${label}: ${t.match(pattern)?.[0]}`);
    expect(found, name).toEqual([]);
  });

  it("only the Orchestrator speaks of Autopilot, and only as the scope of its authority and events", () => {
    for (const [name, text] of [["manager.md", M], ["worker.md", W], ["reviewer.md", R]] as const) {
      expect(text, name).not.toMatch(/autopilot/i);
    }
    rule(O, "Autopilot covers what it covers", /Autopilot, or the owner's own latest message here, covers any effect but/);
    rule(O, "events come only for Autopilot projects", /for Autopilot projects only/);
  });

  it("the Manager never sends answers or questions to a Worker, and a Worker never expects a Manager's facts", () => {
    rule(M, "the plugin delivers the answers", /the plugin delivers each answer to the Worker/);
    rule(M, "BM-ANSWERS goes in the Manager's reply, not to the Worker", /`bm_answers` \*\*in your reply\*\*: the plugin reads it and delivers it, so send the Worker nothing/);
    expect(W).not.toMatch(/Manager verified|your Manager/);
  });

  it("no file teaches mode selection or a self-reported guardrail", () => {
    for (const [name, text] of FILES) {
      expect(text, name).not.toMatch(/set_agent_mode|bypassPermissions|guardrail/);
    }
  });
});

describe("manager.md — the project's context keeper (REQ-117 c–e)", () => {
  it("M1 — changes nothing: every change is a Worker's, reading is its own", () => {
    rule(MR, "changes nothing", /YOU CHANGE NOTHING/);
    rule(MR, "no files, beads, code, builds or tests", /never write files or documents, never create, update or close beads, never change code or configuration, never run a build or a test/i);
    rule(MR, "reading is its own", /Reading is yours/);
  });

  it("M2 — the owner decides the work: no own requirement, no approving a plan, no answering in the owner's place", () => {
    rule(MR, "no requirement of its own", /Add no requirement, check or constraint of your own/);
    rule(MR, "never approves or rejects a plan or technical choice", /never approve, adjust or reject a Worker's plan or technical choice/);
    rule(MR, "never answers a Worker's question for the owner", /never answer a Worker's question in the owner's place/);
    rule(MR, "misalignment goes to the owner", /against the owner's goals you raise with the owner/);
  });

  it("M3, M4, M5 — says only what it saw; cancels a run only for a named reason; no secrets", () => {
    rule(MR, "never more than it sees", /NEVER SAY MORE THAN YOU CAN SEE/);
    rule(MR, "says when it does not know", /say that you do not know/);
    rule(MR, "agents belong to the owner", /AGENTS BELONG TO THE OWNER/);
    rule(MR, "cancel is the one change, for named reasons", /only cancel a run \(`cancel_agent`\): a Worker stuck or off course, one the owner asks to stop, a broken creation/);
    rule(MR, "no secrets, including the environment", /NEVER READ OR PRINT SECRETS\*\* — the environment/);
    verbatim(manager, "`$PASEO_AGENT_ID`");
  });

  it("answers what reading answers, and delegates every change at once", () => {
    rule(M, "answers by reading", /Answer what reading answers/);
    rule(M, "reads the state with the status tools and bm_decisions", /`get_agent_status`, `get_agent_activity`, `bm_decisions`/);
    rule(M, "a build or a test is a change", /What needs a build, a test or a long investigation, or turns into a change, is a change/);
    rule(M, "delegates now", /A change: delegate now/);
    rule(M, "the Worker sizes it", /the Worker sizes it/);
  });

  it("keeps /bm-worker-new and never sends into a running turn", () => {
    verbatim(manager, "`BM-NEW-REQUEST`", "`/bm-worker-new`");
    rule(M, "a new request is a new Worker even while others run", /NEW Worker even while others run/);
    rule(M, "never sends to a running Worker", /Never send to a Worker that is `running`/);
    rule(M, "holds the words for the turn end", /Hold the owner's words, say so, and send them at its turn end/);
  });

  it("keeps the project's context: goals, related requests and earlier decisions (REQ-117 c)", () => {
    rule(M, "the owner's goals", /\*\*the owner's goals\*\*/);
    rule(M, "the related requests, found by label", /\*\*the related requests\*\* \(`list_agents`, label `bm.requestId`/);
    rule(M, "the owner's earlier decisions", /\*\*the owner's earlier decisions\*\* \(`bm_decisions`\)/);
  });

  it("creates the Worker right the first time, and briefs it with that context", () => {
    verbatim(manager, "`req-` + current UTC time as `YYYYMMDDTHHMMSSZ`", "`provider` = `bm-worker/<model of the profile>`", "`bm.role` = `worker`", "`bm.requestId` = the `requestId`", "`bm.version`");
    verbatim(M, "call `list_profiles` **once**", "when it says `none`, pass no `settings.modeId`");
    rule(M, "the request verbatim", /the owner's request \*\*verbatim\*\* in a quoted block/);
    rule(M, "nothing extra", /"Do only what the request asks\. Anything extra is a suggestion for the owner, not work\."/);
    rule(M, "a Context part with goals, decisions and related requests", /\*\*Context\*\*: the owner's goals and earlier decisions that bear on this request and the related requests/);
    rule(M, "context is facts, not how to do the work", /facts, never how to do the work/);
    rule(M, "a collision is named in the brief", /When another Worker writes the same files, beads or history, one line names it/);
  });

  it("checks plan and result against the owner's goals and raises a misalignment as a question (REQ-117 d)", () => {
    rule(M, "at received, beads-done and finished", /At `received`, `beads-done` \(the plan\) and `finished`, compare what the Worker will do or did with the owner's goals/);
    rule(M, "raised in its reply, with options and a recommendation", /raise it in your reply: what you saw, the goal and where the owner said it, one question with two or three options and your recommendation/);
    rule(M, "technical choices are not alignment questions", /How the Worker builds is never this question/);
  });

  it("reads what waits with bm_decisions and writes the owner's typed answers with bm_answers (REQ-117 e)", () => {
    rule(M, "decision cards everywhere", /reach the owner as decision cards — in the Inbox, the Worker's chat and yours/);
    rule(M, "bm_decisions by requestId", /`bm_decisions` with the `requestId` shows what still waits/);
    rule(M, "blocked is one line, never a repeated card", /At `blocked`, say in one line which Worker waits on how many questions; never repeat a card/);
    rule(M, "never picks an option for the owner", /never pick for them/);
    verbatim(M, "`Q6: a — <the option as the Worker wrote it>`", "`Q7: other — <the owner's own words>`");
  });

  it("follows a request from what it sees, and wakes a Worker only on a fact it saw", () => {
    rule(M, "never asks a Worker for progress", /read the Worker's activity rather than ask it/);
    rule(M, "finished: decided choices and suggestions", /how many `decided` choices \(the owner can overturn any\) and suggestions/);
    rule(M, "wakes a waiting Worker on what it has seen", /once you have SEEN it done/);
    rule(M, "archiving is the owner's", /Archiving or deleting is the owner's own action/);
  });

  it("hands notices to the notices, and takes a BM-COMMAND as the owner's word", () => {
    rule(M, "notices say what to do", /each say what to do: do exactly that, and tell the owner only if it says so/);
    rule(M, "a report and a new-request flag are not notices", /A Worker's `BM-REPORT` and the owner's `BM-NEW-REQUEST` are not notices/);
    rule(M, "BM-COMMAND is the owner's word", /Nor is a `BM-COMMAND`: the owner's word/);
    rule(M, "within approved and limits", /within its `approved:` and `limits:`/);
    rule(M, "a copy is context only", /A `copy: yes` block \(what the Orchestrator told your Worker\) is for your context only/);
    rule(M, "one line at most", /mention the Orchestrator's commands in one line at most/);
  });

  it("talks briefly in the owner's language", () => {
    rule(M, "the owner's language", "in the owner's language");
    // Live smoke 2026-09-29: a Manager told the owner about an unrelated connector notice.
    rule(M, "unrelated notices never reach the owner", /tool, connector and system notices that are not about them never reach the owner/);
  });
});

describe("worker.md — sizing, beads, proof and the four questions", () => {
  it("W1 — nothing leaves the workspace without the owner's yes, and says what a yes is", () => {
    rule(WR, "nothing leaves", /NOTHING LEAVES THIS WORKSPACE/);
    for (const thing of [/commit, push or pull request/, /deploy or publish/, /no network/, /dependency/, /migration on real data/, /elevated privileges/, /outside this workspace/]) {
      rule(WR, `W1 covers ${thing}`, thing);
    }
    rule(WR, "an option's declared effects are a yes", /an option the owner chose that declares it in its `effects`/);
    rule(WR, "a command's approved line is a yes", /a `BM-COMMAND` whose `approved:` line lists it/);
  });

  it("W2–W5 — never destroys, never reads secrets, never fakes green, asks only what it cannot decide", () => {
    rule(WR, "W2", /NEVER DESTROY OR UNDO WHAT YOU DID NOT CREATE/);
    rule(WR, "W2 covers the tree it found", /never revert, reformat, stage or discard those/);
    rule(WR, "W3", /NEVER READ OR COPY SECRETS/);
    rule(WR, "W4", /NEVER MAKE A CHECK LOOK GREEN/);
    rule(WR, "W4 no --force", /`--force`/);
    rule(WR, "W5", /ASK ONLY WHAT YOU CANNOT DECIDE/);
    rule(WR, "no default for the four", /never go on with a default/);
  });

  it("names the owner's change as the job and beads as the instrument, and says which text decides", () => {
    rule(W, "the change is the job", /\*\*Your job is the change the owner asked for\*\*/);
    rule(W, "beads are the instrument", /your instrument, not your goal/);
    rule(W, "this file decides", /on safety, the review budget, reporting, asking and scope, \*\*this file decides\*\*/);
  });

  it("keeps one loop, and a Small or design-free request gets no bead, document or review", () => {
    rule(W, "one loop at every tier", /One loop, from the request to `finished`, the same at every tier/);
    rule(W, "Small: no bead, no Reviewer, no review call", /gets no bead, document, Reviewer or review call/);
    rule(W, "documents only where something recorded is overturned", /Write documents only where the change overturns something recorded/);
    rule(W, "no confirmation to wait for", /no confirmation to wait for/);
    rule(W, "keeps its context small", /Keep your context small/);
  });

  it("sizes by risk into Small, Medium and Large, with the review budget 2 / 2 / 4", () => {
    rule(W, "size the risk, not the diff", /Size the risk of what you design, not the diff/);
    for (const tier of ["**Large**", "**Small**", "**Medium**"]) verbatim(worker, tier);
    verbatim(worker, "| **Review calls per request** | **2** | **2** | **4** |");
    rule(W, "raises the tier when it learns more", /Raise the tier and say so when you learn more/);
  });

  it("keeps the bead rules: one outcome, labels, siblings on a split, lint headings, provenance", () => {
    rule(W, "one outcome", /one outcome/);
    rule(W, "Primary Proof and Reversibility", /\*\*Primary Proof\*\* named before you start and its \*\*Reversibility\*\*/);
    verbatim(W, "`feature:<slug>`", "`br list --label feature:<slug> --json`", "`Split-from: <id>`", "`## Acceptance Criteria`", "`## Success Criteria`", "`## Provenance`", "`br lint -s all`");
    rule(W, "never delete a bead", /never delete a bead/);
    rule(W, "no bead depends on its own children", /never make one depend on its own children/);
  });

  it("proves each bead with the cheapest evidence and closes it only after reading the result", () => {
    rule(W, "cheapest evidence", /\*\*the cheapest evidence that the outcome happened\*\*/);
    rule(W, "git status first", /Run `git status` once before your first write/);
    verbatim(W, "`br update <id> --status in_progress`", "`br close <id> --reason \"<the evidence>\"`");
    rule(W, "one bead at a time", /One bead `in_progress` at a time/);
    rule(W, "reads the check's own result", /after reading the check's own result/);
    rule(W, "reopen on a blocking finding", /`br reopen <id>`/);
  });

  it("asks only the four kinds, once and early, and decides what it can undo", () => {
    rule(W, "decides what it can undo", /\*\*Decide what you can undo\*\*/);
    rule(W, "records decisions on decided", /`decided` line/);
    for (const kind of ["**Scope**", "**What rules 1 and 2 guard, and approved decisions**", "**What only the owner has**", "**Being stuck**"]) verbatim(W, kind);
    rule(W, "at most five, counted across the request", /at most 5 questions per round, numbered `Q1`, `Q2`, … across the request/);
    rule(W, "one recommended", /exactly one recommended/);
    rule(W, "no AskUserQuestion", /`AskUserQuestion` returns nothing here/);
    rule(W, "silence is not an answer", /silence is never an answer/);
    rule(W, "an action option reads as done", /written as done when chosen/);
  });

  it("declares a subject per question and effects per option, and re-asks with supersedes (design §A.3, §A.5)", () => {
    rule(W, "subject", /a `subject` \(a short slug for what is decided, the same when you ask it again\)/);
    rule(W, "effects per option", /each option its `effects`/);
    rule(W, "the owner's choice is a yes for exactly those effects", /the owner's choice is their yes for exactly those/);
    rule(W, "supersedes", /ask under a new number with `supersedes: <the old Qn>` and the same `subject`/);
    rule(W, "blocked through bm_report", /Send them with `blocked` through `bm_report`/);
  });

  it("shows the fallback BM-QUESTIONS block with tags the plugin reads", () => {
    const set = parseQuestions(fenced(worker, "BM-QUESTIONS"));
    expect(set?.requestId).toBe("req-20260917T010956Z");
    const [q1] = set!.questions;
    expect(q1?.subject).toBe("user-list-storage");
    expect(q1?.options.filter((option) => option.recommended).map((option) => option.key)).toEqual(["a"]);
    expect(q1?.options.map((option) => option.effects)).toEqual([["none"], ["migration"]]);
    for (const option of q1!.options) for (const effect of option.effects ?? []) expect(EFFECTS).toContain(effect);
  });

  it("takes answers from the plugin's delivery, and leaves an open question on its card", () => {
    verbatim(W, "`BM-DELIVERY answers`", "`Continue <requestId>.`", "`BM-ANSWERS`");
    rule(W, "own words", /`Q2: other — …` is the owner's words/);
    rule(W, "an open question stays open, no default, not re-asked", /stays open on its card: carry on with what it does not touch, never pick a default for it, and do not ask it again/);
  });

  it("creates and briefs the Reviewer, and keeps one review and one re-review per batch", () => {
    verbatim(worker, "`bm.role` = `reviewer`", "`bm.requestId`", "`bm.batchId` = the batch id", "`bm.version`");
    verbatim(W, "provider `bm-reviewer/<model of the profile>`", "Runtime facts` (`none`: pass no mode;");
    rule(W, "one review, one re-review", /one review and, only while blocking findings remain, one re-review/);
    rule(W, "the same Reviewer re-reviews", /ask the same Reviewer for the re-review with `send_agent_prompt`/);
    rule(W, "non-blocking goes to suggestions", /list the rest in `suggestions`/);
    rule(W, "a call past the budget is asked", /a review call past the table's number the owner did not ask for: send `blocked` and ask/);
    rule(W, "a provider error is not a review", /is not a review: create no other, end your turn without a report, and wait for the plugin's `BM-FALLBACK`/);
  });

  it("reports only at the four phases with bm_report, and keeps the fallback BM-REPORT block", () => {
    rule(W, "send_agent_prompt without a wake-up", /`send_agent_prompt` and `notifyOnFinish: false`/);
    rule(W, "only at the four phases", /\*\*only\*\* at `received`, `beads-done` \(Large\), `blocked` and `finished`/);
    rule(W, "verbatim from bm_report", /with `bm_report` and send what it returns verbatim/);
    const template = fenced(worker, "BM-REPORT");
    const fields = template.split("\n").slice(1).map((line) => line.split(":")[0]);
    expect(fields).toEqual(["requestId", "phase", "tier", "filesChanged", "beadsCreated", "beadsUpdated", "beadsClosed", "beadsReady", "reviewFindingsOpen", "buildAndTests", "skillsUsed", "decided", "blockers"]);
    rule(W, "tells the owner in the owner's language", "in the owner's language");
  });

  it("hands notices to the notices, and follows a BM-COMMAND within its rules", () => {
    rule(W, "notices say what to do", /each say what to do: do exactly that/);
    rule(W, "BM-COMMAND is the owner's word", /A `BM-COMMAND` is the owner's word/);
    rule(W, "within its rules", /follow it within your rules/);
    rule(W, "checks an interrupted step first", /if it cut a step short, check that step first and report it as interrupted by the Orchestrator/);
  });

  it("treats only a stop message or an empty resume as a stop, and stops its Reviewers first", () => {
    rule(W, "what a stop is", /\*\*A turn is a STOP only if it brings\*\*/);
    verbatim(W, "`BM-STOP`");
    rule(W, "cancels its Reviewers, cancel only", /call `cancel_agent` on every Reviewer you created that is still running \(cancel only\)/);
    rule(W, "then finished and idle", /send `finished` saying exactly where you stopped/);
  });
});

describe("reviewer.md — review against the request, blocking vs not, one result", () => {
  it("keeps its four limits", () => {
    rule(RR, "R1", /YOU CHANGE NOTHING/);
    rule(RR, "a tool is not permission", /Having a tool is not permission to use it/);
    rule(RR, "R2", /NOTHING LEAVES THIS MACHINE/);
    rule(RR, "R3", /NEVER READ SECRETS/);
    rule(RR, "R4", /ONE BATCH, ONE RESULT/);
  });

  it("says nothing about other agents' work or tools (design §A.11)", () => {
    expect(R).not.toMatch(/create_agent|send_agent_prompt|cancel_agent|archive|Manager|Orchestrator/);
  });

  it("reviews against the request, does not guess a missing scope, and scales effort to risk", () => {
    rule(R, "against the request", /REVIEW AGAINST THE REQUEST, NOT AGAINST PERFECTION/);
    rule(R, "no guessing", /do not guess\*\*: return `changes-required` with one blocking finding/);
    rule(R, "effort in proportion to risk", /with effort in proportion to risk/);
    rule(R, "re-review checks only the previous blocking findings", /check ONLY that the previous blocking findings are fixed/);
    rule(R, "says when the tree changed", /`git status --porcelain` before and after/);
  });

  it("owns the criteria of every stage, loaded as criteria only, and tries abuse cases on sensitive batches", () => {
    for (const stage of ["documents", "plan", "beads", "implementation"]) expect(reviewer).toMatch(new RegExp(`^\\| \`${stage}\` \\|`, "m"));
    rule(R, "criteria only", /loaded as criteria only/);
    rule(R, "abuse cases", /authorization bypass, session revocation, check-then-write races, malformed input, unbounded resources, secret exposure/);
  });

  it("blocks only what is wrong or unsafe, with one contrast pair (owner decision Q20)", () => {
    rule(R, "blocking", /\*\*BLOCKING — only when the batch is wrong or unsafe for what the owner asked:\*\*/);
    rule(R, "non-blocking", /\*\*NON-BLOCKING — everything else\*\*/);
    rule(R, "never upgrade a suggestion", /Never upgrade a suggestion/);
    rule(R, "the pair", /is \*\*blocking\*\* — an exploitable defect in what this batch built; .* is \*\*non-blocking\*\* — protection nobody asked for/);
  });

  it("answers through bm_review, and keeps the fallback BM-REVIEW block and its BM-FORMAT rule", () => {
    rule(R, "bm_review first", /Build your answer with `bm_review`/);
    const block = fenced(reviewer, "BM-REVIEW");
    for (const field of ["requestId:", "batchId:", "reviewKind: first | re-review", "verdict: pass | changes-required", "checked:", "findings:", "- severity: blocking | non-blocking", "  location:", "  reason:", "  suggestedFix:", "notChecked:"]) {
      expect(block, field).toContain(field);
    }
    verbatim(R, "A message that starts with `BM-FORMAT` is the plugin's: answer with the whole corrected `BM-REVIEW` block only; do not review again.");
  });

  it("answers any stop with one line", () => {
    verbatim(R, "`STOP: The Beads Worker that created you was stopped by the user.`", "`BM-REVIEW STOPPED`");
  });
});

describe("orchestrator.md — decides what reaches it, verifies, declares effects, asks with prepared actions", () => {
  it("keeps three limits: changes nothing, acts within the owner's authority, only what its tools show", () => {
    rule(OR, "changes nothing", /YOU CHANGE NOTHING YOURSELF/);
    rule(OR, "provider tools are not for this job", /your provider's own shell and file tools are not for this job/);
    rule(OR, "authority", /YOU ACT ONLY AS FAR AS THE OWNER'S AUTHORITY GOES/);
    rule(OR, "declares intent and effects", /Every command declares its intent and every effect its text shows/);
    rule(OR, "only what its tools show", /ONLY WHAT YOUR TOOLS SHOW/);
    rule(OR, "never guesses", /you NEVER guess/);
  });

  it("names the effects only an answered decision's grant covers, exactly as the plugin does (design §A.7)", () => {
    const owed = OR.slice(OR.indexOf("covers any effect but"), OR.indexOf("which need the grant"));
    for (const effect of CONFIRM_EFFECTS) expect(owed, effect).toContain(effect);
    rule(OR, "the grant of an answered decision", /need the grant of a decision the owner answered/);
  });

  it("names every tool it is served, and no retired one", () => {
    const served = toolFacesFor("orchestrator").map((face) => face.name);
    for (const name of served) expect(orchestrator, name).toContain(`\`${name}\``);
    rule(O, "summaries by default, full on demand", /pass `detail: "full"` only when one does not answer/);
    rule(O, "verifies a claim with bm_repo", /check a claim with it before acting on it/);
    rule(O, "keeps notes", /one short note per decision, preference or standing instruction/);
  });

  it("knows what reaches it: the owner's messages, BM-EVENTS lines and BM-ANSWER notices", () => {
    rule(O, "BM-EVENTS is never the owner's word", /\*\*`BM-EVENTS`\*\* is the plugin's, never the owner's word/);
    rule(O, "looks before it acts, and does not reply to nothing", /Look before you act; nothing to do: do not reply/);
    const events: BmEvent[] = [
      { type: "decision.opened", workspaceId: "w", requestId: "r", decisionId: "q:r:Q1", askedBy: null },
      { type: "request.finished", workspaceId: "w", requestId: "r", managerId: "m", at: "t" },
      { type: "request.stalled", workspaceId: "w", requestKey: "r", managerId: null, reason: "idle-unfinished", since: "t" },
      { type: "worker.signal", workspaceId: "w", workerId: "x", requestKey: "r", signal: "stuck", since: "t" },
    ] as BmEvent[];
    for (const event of events) {
      expect(eventLineOf(event)).toContain(event.type);
      expect(orchestrator, event.type).toContain(`\`${event.type}\``);
    }
    for (const signal of ["stuck", "permission", "danger", "failing", "heavy", "outside"]) expect(O, signal).toContain(`\`${signal}\``);
    rule(O, "danger is interrupted only when allowed", /`interrupt: true` — allowed only when the line says so/);
    // change-004: a decision.opened is answered with bm_decide when Autopilot covers the option, else it stays the owner's.
    rule(
      O,
      "a decision.opened is answered with bm_decide, or left to the owner",
      /`decision\.opened` — a Worker asks the owner\. Read it with `bm_decisions`\. If Autopilot covers the option you choose, answer with `bm_decide`; otherwise leave it to the owner\./,
    );
    expect(O, "no answer to a stored question in a command").not.toMatch(/answer with `bm_direct_worker`|intent `answer`, a `BM-ANSWERS` block/);
    rule(O, "BM-ANSWER carries a grant used with decisionId", /\*\*`BM-ANSWER`\*\* is the owner's answer to one of your decisions, with its grant/);
    rule(O, "carries the answer out with decisionId", /passing `decisionId`, so the grant covers the effects the owner approved/);
  });

  it("writes commands as the owner would, never to a Reviewer, and never rewords around a refusal", () => {
    rule(O, "the Manager's language", /in the language of that Manager's chat with the owner/);
    rule(O, "never a Reviewer", /never to a Reviewer/);
    rule(O, "a refusal sent nothing", /A refusal means nothing was sent/);
    rule(O, "never reword", /never reword to get through/);
    // A Worker's question is answered through the decision store, never in a command (change-004).
    rule(O, "direct commands only correct", /`bm_direct_worker` \(to a Worker: only a correction; its Manager gets a copy\)/);
    rule(O, "a Worker's question is bm_decide's", /`bm_decide` \(a Worker's question\)/);
  });

  it("asks the owner with prepared actions, one open decision per request, and claims no replacement the tool did not report", () => {
    rule(O, "options with effects and a prepared command", /each with its effects and, to act at once when chosen, a prepared command \(`to`, `agentId`, `intent`, `body`\)/);
    rule(O, "one open decision per request", /One open decision per request: a new one replaces yours unless `separate: true`/);
    rule(O, "only a reported replacement", /say so only when the tool names the replaced id/);
  });

  it("assesses a workflow once with the rubric, and applies nothing", () => {
    rule(O, "once", /call `bm_assessment` \*\*once\*\* with that `workspaceId`/);
    rule(O, "never says it applied a suggestion", /never say you added or applied a suggestion/);
    rule(O, "in English", /Write it in English/);
  });

  it("answers the owner as Situation / Done / Needs you, and the owner's word wins", () => {
    verbatim(O, "**Situation**", "**Done**", "**Needs you**");
    rule(O, "the owner's language", "in the owner's language");
    rule(O, "the owner wins", /The owner's word wins/);
  });
});

// The role files name no per-notice procedure: each plugin message says what
// its receiver does (design delta 20260924-instruction-quality §2.1). These pin
// that the messages keep saying it.
describe("plugin messages carry their own instructions", () => {
  it("each notice says what its receiver does", () => {
    expect(formatNotice("BM-REPORT", "req-X", ["x"])).toMatch(/Send the whole corrected block again[^\n]*Do not mention this notice to the user\.$/);
    expect(formatNotice("BM-REPORT", "req-X", ["x"], true)).toMatch(/Do NOT send this block again[^\n]*Do not mention this notice to the user\.$/);
    for (const part of ["never revert it", "Continue the review budget from `reviewCalls`", "send `received` to `managerAgentId`"]) {
      expect(WORKER_CLOSING, part).toContain(part);
    }
    expect(settingsNotice("Worker mode: `x`")).toMatch(/replaces the matching line[\s\S]*Do not reply to this message; carry on/);
    expect(managerIdNotice("m-2")).toContain("send every BM-REPORT to this agent from now on");
    expect(RESUME_NOTICE).toContain("Continue from where you stopped; do not redo finished work.");
    expect(toolsNotice("w", "pi")).toContain("Tell the user in one line; do not create another Worker");
    expect(budgetNotice({ requestId: "req-X", tier: "Small", calls: 3, budget: 2, managerAgentId: "m" })).toMatch(/Tell the user in one line\. Do not cancel on this notice alone/);
  });
});
