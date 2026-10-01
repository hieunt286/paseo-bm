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
import { toolFacesFor, toolNamed } from "../plugin/shared/bm-tools";
import { parseQuestions } from "../plugin/shared/bm-questions";
import { CONFIRM_EFFECTS, DECISION_CLASSES, EFFECTS, checkedClass, type Decision } from "../plugin/shared/decisions";
import { eventLineOf, type BmEvent } from "../plugin/server/event-bus";
import { answerNoticeOf } from "../plugin/server/orchestrator-decisions";
import { OWNER_PRECEDENTS_HEADING, runtimeFactsText, workerSkillsLine } from "../plugin/server/role-instructions";
import { boundaryVerdictOfCommand } from "../plugin/shared/effectful-actions";

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
 *
 * What the plugin already tells the agent — a tool's description, an event
 * line, a notice, a Runtime fact — the role file only points at (bead
 * bm-consolidation-81y2.24): the duty is then pinned on the plugin's text,
 * here or in "plugin messages carry their own instructions", not on the role's.
 */
const orchestratorFace = (name: string) => {
  const face = toolFacesFor("orchestrator").find((candidate) => candidate.name === name);
  expect(face, name).toBeDefined();
  return face!;
};
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
  it("says what replaced Autopilot (autonomy design §B.8): the owner's word, a class the owner delegated, and the policy's scope for events", () => {
    rule(O, "the owner's word covers what it covers", /The owner's own latest message here covers any effect but/);
    rule(O, "a delegated class covers its own effects", /a class the owner delegated covers its own/);
    rule(O, "events beyond decisions come only where the policy shadows or delegates a class", /the rest only where the owner's policy shadows or delegates a class/);
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
    verbatim(M, "call `list_profiles` **once**");
    // The mode and what `none` means are the Runtime fact's own words (pinned below); the role points at it.
    rule(M, "the Worker's mode exactly as the Runtime facts say", /`settings\.modeId` exactly as your `## Runtime facts` say/);
    rule(M, "the request verbatim", /the owner's request \*\*verbatim\*\* in a quoted block/);
    rule(M, "nothing extra", /"Do only what the request asks\. Anything extra is a suggestion for the owner, not work\."/);
    rule(M, "a Context part with goals, decisions, precedents and related requests", /\*\*Context\*\*: the owner's goals, earlier decisions and precedents \(your `## Owner precedents`\) that bear on this request and the related requests/);
    rule(M, "context is facts, not how to do the work", /facts, never how to do the work/);
    rule(M, "a collision is named in the brief", /When another Worker writes the same files, beads or history, one line names it/);
  });

  it("briefs the Worker with the owner's precedents from the heading the plugin writes (REQ-117 c, design §B.6)", () => {
    verbatim(manager, `\`${OWNER_PRECEDENTS_HEADING}\``);
    rule(M, "the precedents that bear on the request go in the Context part", /earlier decisions and precedents \(your `## Owner precedents`\) that bear on this request/);
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
    // Design §A.11 drops the long notice list: a notice that says what to do is not named.
    expect(M).not.toMatch(/`BM-(FORMAT|BUDGET|SETTINGS|HANDOVER|RESUME|FALLBACK|TOOLS)`/);
    rule(M, "a report and a new-request flag are not notices", /A Worker's `BM-REPORT` and the owner's `BM-NEW-REQUEST` are not notices/);
    rule(M, "BM-COMMAND is the owner's word", /Nor is a `BM-COMMAND`: the owner's word/);
    rule(M, "within approved and limits", /within its `approved:` and `limits:`/);
    rule(M, "a copy is context only", /A `copy: yes` block \(what the Orchestrator told your Worker\) is for your context only/);
    rule(M, "one line at most", /mention the Orchestrator's commands in one line at most/);
    // Design §G.6 (bead 7gxw.11): one bullet executes a handoff, naming the bm.handoffFrom label; the request keeps its id.
    rule(
      M,
      "a handoff: the successor with bm.handoffFrom and the brief, the old Worker told",
      /\*\*A handoff\*\* \(`intent: handoff`\): create the new Worker as it says, for the same `requestId`, with `bm\.handoffFrom` = the old Worker's id and its brief verbatim as `initialPrompt`; then tell the old Worker it is replaced\./,
    );
  });

  it("talks briefly in the owner's language", () => {
    rule(M, "the owner's language", "in the owner's language");
    // Live smoke 2026-09-29: a Manager told the owner about an unrelated connector notice.
    rule(M, "unrelated notices never reach the owner", /tool, connector and system notices that are not about them never reach the owner/);
  });
});

/**
 * The action boundary in the Worker's instructions (autonomy design §D.2,
 * change-010 C7): the lead-in no longer says it runs without prompts; it says
 * the Runtime facts tell whether the boundary is on, that the plugin then holds
 * what leaves the workspace until the owner allows it, and that the five rules
 * bind either way. The scratch folder is named literally in every command, in
 * forms the classifier reads as scratch.
 */
describe("worker.md — the action boundary and a literal scratch folder (change-010 C7)", () => {
  it("says whether the boundary holds comes from the Runtime facts, what it holds, and that the rules bind either way", () => {
    expect(worker).not.toContain("You run without permission prompts");
    expect(W).not.toMatch(/only barrier/);
    rule(WR, "the facts say whether the boundary is on", /When your `## Runtime facts` say `Action boundary: on`/);
    rule(WR, "the plugin holds what leaves the workspace until the owner allows it", /the plugin also holds an action that leaves this workspace until the owner allows it/);
    rule(WR, "the five bind either way", /the five bind either way/);
  });

  it("names the scratch folder literally in every command, never through a variable from an earlier call, and says why", () => {
    rule(WR, "rule 1: named literally and deleted before the next report", /one `mktemp -d` scratch directory, named literally in each command \(Proving a change\) and deleted before your next report/);
    rule(W, "the two forms", /`S=\$\(mktemp -d\) && … && rm -rf "\$S"` in one command, or later the path `mktemp -d` printed \(or a `\/tmp\/…` path\)/);
    rule(W, "never a variable from an earlier call", /never as a variable from an earlier call/);
    rule(W, "why: the plugin can read it", /so the plugin can read it and not stop you/);
  });

  it("each scratch form worker.md names is read as scratch by the classifier; a variable from an earlier call is not", () => {
    const workspace = "/work/app";
    // No daemon TMPDIR: the system temp roots alone, as the replay reads them.
    const context = { cwd: workspace, workspaceDirectory: workspace, homeDirectory: "/Users/owner" };
    const oneCommand = /`(S=\$\(mktemp -d\) && … && rm -rf "\$S")`/.exec(worker)?.[1];
    expect(oneCommand, "the one-command form").toBeDefined();
    const forms = [
      // The one-command form, with work where the file writes `…`.
      oneCommand!.replace("…", `cp -r src "$S" && echo done > "$S/out.txt" && mkdir -p "$S/build"`),
      // The path `mktemp -d` printed, named literally in a later command: macOS and Linux.
      "echo done > /var/folders/ab/cd/T/tmp.Xy12AbCd/out.txt && rm -rf /var/folders/ab/cd/T/tmp.Xy12AbCd",
      "mkdir -p /tmp/tmp.Xy12AbCd/build && cp -r src /tmp/tmp.Xy12AbCd/build && rm -rf /tmp/tmp.Xy12AbCd",
      // A literal `/tmp/…` path.
      "echo x > /tmp/bm-scratch/notes.txt && rm -rf /tmp/bm-scratch",
    ];
    for (const command of forms) {
      const verdict = boundaryVerdictOfCommand(command, context);
      expect([command, verdict.findings]).toEqual([command, []]);
      expect(verdict.scratchWrites, command).toBeGreaterThan(0);
    }
    // What the file tells the Worker not to do: a variable set in an earlier call cannot be read.
    expect(boundaryVerdictOfCommand(`echo done > "$S/out.txt"`, context).findings.map((finding) => finding.unreadable)).toEqual([true]);
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

  it("sizes by risk into Small, Medium and Large, with the review budget of its Runtime facts, 2 / 2 / 4 without them", () => {
    rule(W, "size the risk, not the diff", /Size the risk of what you design, not the diff/);
    for (const tier of ["**Large**", "**Small**", "**Medium**"]) verbatim(worker, tier);
    // Bead 7gxw.12: the owner's budget per tier is a Runtime fact (Settings → Coordination); the defaults stay here.
    verbatim(worker, "**Review calls per request:** as your `## Runtime facts` say (else 2 / 2 / 4),");
    expect(worker).not.toContain("| **Review calls per request** |");
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

  it("names each check exactly as run, in backticks, without pipes, so the plugin can detect it (autonomy design §C.2, §C.6)", () => {
    verbatim(
      W,
      "Run each check after your last edit, without pipes or redirections, and **name it in `buildAndTests` exactly as run**, in backticks, with pass/fail: `npm test` pass; `tsc` pass.",
    );
    const field = (toolNamed("bm_report")!.inputSchema as { properties: Record<string, { description?: string }> }).properties["buildAndTests"]?.description;
    expect(field).toContain("Each check exactly as you ran it, in backticks, with pass/fail");
    expect(field).toContain("Backticks only around commands.");
    expect(field).toContain("only from a run after your last edit, without pipes or redirections");
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

  it("consults the owner's precedents before asking, follows and cites one, and asks the rest under its subject (REQ-124 b, design §B.6)", () => {
    verbatim(worker, `\`${OWNER_PRECEDENTS_HEADING}\``);
    rule(W, "precedents first", /\*\*Look before you ask\*\*: first your `## Owner precedents`/);
    rule(W, "a precedent that answers is followed and cited", /one that answers a question is the owner's answer: follow it and cite its `subject`/);
    rule(W, "what it leaves open, or rule 1 guards, is asked with its subject", /ask what it leaves open, or what rule 1 guards, with that `subject`/);
  });

  it("proposes a class per question from the nine, riskiest first, the riskier when unsure (design §B.1)", () => {
    // Kept although `bm_report`'s schema lists them too (bead 81y2.24): a Worker on a provider without the
    // plugin's tools (Pi, Copilot: `TOOL_PROVIDERS`) writes BM-QUESTIONS by hand, and an unknown class tag is
    // dropped, which files the question as the most delegable class, reversible-technical.
    verbatim(W, `a \`class\` (riskiest first: ${DECISION_CLASSES.join(", ")}; the riskier when unsure)`);
  });

  it("shows the fallback BM-QUESTIONS block with tags the plugin reads", () => {
    const set = parseQuestions(fenced(worker, "BM-QUESTIONS"));
    expect(set?.requestId).toBe("req-20260917T010956Z");
    const [q1] = set!.questions;
    expect(q1?.subject).toBe("user-list-storage");
    // The example's class is the one the plugin keeps for its options (a migration is data).
    expect(q1?.class).toBe("data");
    expect(checkedClass(q1?.class, q1!.options.flatMap((option) => option.effects ?? []))).toBe("data");
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
    verbatim(W, "provider `bm-reviewer/<model of the profile>`");
    // The mode, and what `none` means, are the Runtime fact's own words (bead 81y2.24); a refusal is the owner's to hear.
    rule(W, "the Reviewer's mode exactly as the Runtime facts say", /`settings\.modeId` exactly as your `## Runtime facts` say/);
    rule(W, "a refused creation is blocked with Paseo's refusal", /send `blocked` with Paseo's refusal/);
    rule(W, "one review, one re-review", /one review and, only while blocking findings remain, one re-review/);
    rule(W, "the same Reviewer re-reviews", /ask the same Reviewer for the re-review with `send_agent_prompt`/);
    rule(W, "non-blocking goes to suggestions", /list the rest in `suggestions`/);
    rule(W, "a call past the budget is asked", /a review call past your budget the owner did not ask for: send `blocked` and ask/);
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
    // Only the notices it treats in its own way are named: `BM-DELIVERY answers`, `BM-FALLBACK`, `BM-STOP`.
    expect(W).not.toMatch(/`BM-(FORMAT|BUDGET|SETTINGS|HANDOVER|RESUME|TOOLS)`/);
    rule(W, "BM-COMMAND is the owner's word", /A `BM-COMMAND` is the owner's word/);
    rule(W, "within its rules", /follow it within your rules/);
    rule(W, "checks an interrupted step first", /if it cut a step short, check that step first and report it as interrupted by the Orchestrator/);
    // Design §G.6 (bead 7gxw.11): one bullet — the note, and working from a brief as the successor who proves again.
    rule(W, "the handoff note", /`BM-HANDOFF` asks your note \(`handoffNote`\) for the Worker taking over/);
    rule(W, "the successor proves again", /a first message `BM-HANDOFF-BRIEF` makes you that Worker: prove every check again before a report says it passes/);
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

  it("points at its tools' own descriptions instead of listing them, and names no tool it is not served", () => {
    // Bead 81y2.24: the hand-kept list had drifted (bm_predict missing, bm_assessment still there).
    rule(O, "the tools describe themselves", /Each `bm_` tool's own description says what it reads or does and what it refuses/);
    const served = toolFacesFor("orchestrator").map((face) => face.name);
    for (const face of toolFacesFor("orchestrator")) expect(face.description.length, face.name).toBeGreaterThan(40);
    const named = [...orchestrator.matchAll(/`(bm_[a-z_]+)`/g)].map((match) => match[1]!);
    for (const name of named) expect(served, name).toContain(name);
    // What the descriptions do not say: how much to read, verify first, what to note, and without tools.
    rule(O, "summaries by default, full on demand", /`detail: "full"` only when (one|a summary) does not answer/);
    rule(O, "verifies a claim with bm_repo", /check a claim with (it|`bm_repo`) before acting on it/);
    // Autonomy design §E.2 (bead 3e5v.3): one line on when to read a chain with bm_why.
    rule(O, "reads why with bm_why before acting on it", /before acting on a claim about why a bead, a file or a decision exists, read its chain with `bm_why`/);
    rule(O, "keeps notes", /one short note per decision, preference or standing instruction/);
    rule(O, "without its tools: one line and stop", /Without (them|the tools), say so in one line and stop/);
  });

  it("knows what reaches it: the owner's messages, BM-EVENTS lines and BM-ANSWER notices", () => {
    rule(O, "BM-EVENTS is never the owner's word", /\*\*`BM-EVENTS`\*\* is the plugin's, never the owner's word/);
    rule(O, "looks before it acts, and does not reply to nothing", /Look before you act; nothing to do: do not reply/);
    const events: BmEvent[] = [
      { type: "decision.opened", workspaceId: "w", requestId: "r", decisionId: "q:r:Q1", askedBy: null, asks: "decision" },
      { type: "request.finished", workspaceId: "w", requestId: "r", managerId: "m", at: "t" },
      { type: "request.stalled", workspaceId: "w", requestKey: "r", managerId: null, reason: "idle-unfinished", since: "t" },
      { type: "worker.signal", workspaceId: "w", workerId: "x", requestKey: "r", signal: "stuck", since: "t" },
      { type: "advice.due", workspaceId: "w", finished: 5, at: "t" },
      { type: "threshold.crossed", workspaceId: "w", requestId: "r", agentId: "x", role: "worker", kind: "compact", figure: "tokensPerTurn", value: 6, threshold: 5, at: "t", cycle: 0 },
      {
        type: "writers.observed",
        workspaceId: "w",
        file: "src/a.js",
        writers: [
          { agentId: "x", role: "worker", requestId: "r", startedAt: "t0" },
          { agentId: "y", role: "worker", requestId: null, startedAt: "t1" },
        ],
        alertKey: "writers-observed:w:src/a.js",
        at: "t",
      },
    ] as BmEvent[];
    for (const event of events) {
      expect(eventLineOf(event)).toContain(event.type);
      expect(orchestrator, event.type).toContain(`\`${event.type}\``);
    }
    // Design §F.1 (bead i8fc.1): two agents on one file is detection only; the Orchestrator checks it and tells the Manager.
    rule(
      O,
      "writers.observed: check the file with bm_repo, tell its Manager when one change may have undone the other",
      /`writers\.observed` — two agents wrote one file in overlapping turns: check it with `bm_repo`; if one change may have undone the other, tell its Manager\./,
    );
    for (const signal of ["stuck", "permission", "danger", "failing", "heavy", "outside"]) expect(O, signal).toContain(`\`${signal}\``);
    rule(O, "danger: stopped unless the owner asked for it", /`danger` \(unless the owner asked for it, stop it with `bm_direct_worker`\)/);
    // When it may interrupt is the line's and the tool's to say (bead 81y2.24).
    const danger = eventLineOf({ type: "worker.signal", workspaceId: "w", workerId: "x", requestKey: "r", signal: "danger", since: "t", interruptUntil: "t2" } as BmEvent);
    expect(danger).toContain("You may interrupt this Worker until t2 (bm_direct_worker with interrupt: true).");
    expect(orchestratorFace("bm_direct_worker").description).toContain("allowed only while a danger signal of that Worker is open");
    // Design §B.5, §B.3, §B.9 (beads t9lm.11, t9lm.7): a decision.opened asks the Orchestrator to decide only where the
    // owner delegated its class to it, or to predict where the challenger is on. Its line says which and with which tool
    // (bead 81y2.24); the role points at it.
    rule(O, "a decision.opened is decided or predicted as its line says", /`decision\.opened` — decide or predict it exactly as its line says/);
    rule(O, "a decision reaches it only to decide or predict", /a decision only to decide or predict it, the rest only where the owner's policy shadows or delegates a class/);
    // Design §G.4 (bead t9lm.25): advice reaches it for every project, whatever the policy; the bullet says what to do.
    rule(O, "advice for every project", /one line per event with ids to look up — advice for every project, a decision only/);
    rule(
      O,
      "advice.due: the findings, one decision per finding worth acting on with its change, else a note",
      /`advice\.due` — read the project's `bm_findings`; ask the owner with `bm_ask_owner` about each finding worth acting on, its change on an option; none worth it: a note with `bm_note`\. The owner may ask for advice anytime\./,
    );
    // Bead 7gxw.12: §G.4's review.budget is a coordination.set on a review-budget key, not a kind of its own.
    rule(O, "a review budget is a coordination.set on its tier's key", /A review budget is a `coordination\.set` on its tier's `review\.\*Budget` key\./);
    // Design §G.5, §G.7 (bead 7gxw.10): a crossed threshold, in any project, is compacted with bm_compact when worth it, else a note;
    // its line names the tool, and the tool's own description says what it refuses and how it runs.
    rule(
      O,
      "threshold.crossed: bm_compact when worth it, else a note",
      /`threshold\.crossed` — a Manager's or a Worker's context crossed the owner's threshold, in any project: have it compact with `bm_compact` when that is worth it \(the plugin picks its safe point and restores its state from the records\); otherwise a note with `bm_note`\./,
    );
    const crossed = eventLineOf({ type: "threshold.crossed", workspaceId: "w", requestId: null, agentId: "m", role: "manager", kind: "compact", figure: "contextShare", value: 0.62, threshold: 0.5, at: "t", cycle: 1 });
    expect(crossed).toBe(
      "- threshold.crossed compact — project w, Manager m, request none, at t: its context filled 62 % of its window (threshold 50 %). If a compaction is worth it, request it with bm_compact; the plugin runs it at that agent's next safe point. Otherwise keep a note with bm_note.",
    );
    for (const part of ["never inside a running turn", "never a Reviewer, never you", "a Worker's next step is a handoff", "BM-STATE brief", "Refused, changing nothing, when compaction is off"]) {
      expect(orchestratorFace("bm_compact").description, part).toContain(part);
    }
    // Design §G.6, §G.7 (bead 7gxw.11): its handoff kind is handed to a new Worker with bm_handoff when worth it; the line
    // names the tool, and the tool's description says what it refuses and how the Manager creates the successor.
    rule(
      O,
      "threshold.crossed handoff: bm_handoff when worth it",
      /A `handoff` line — a Worker's request grew heavy: have it handed to a new Worker with `bm_handoff` when that is worth it \(its Manager creates the successor from the plugin's brief\)\./,
    );
    const handedOver = eventLineOf({ type: "threshold.crossed", workspaceId: "w", requestId: "r", agentId: "x", role: "worker", kind: "handoff", figure: "requestTokens", value: 160_000_000, threshold: 150_000_000, at: "t", cycle: 0 });
    expect(handedOver).toContain("If a handoff to a new Worker is worth it, request it with bm_handoff");
    for (const part of [
      "Refused, changing nothing, when handoff is off",
      "sends the Worker's Manager a BM-COMMAND to create the successor",
      "the old Worker stays idle and is never archived",
      "the successor proves its work again",
      "Logged as a handoff intervention",
    ]) {
      expect(orchestratorFace("bm_handoff").description, part).toContain(part);
    }
    const advice = eventLineOf({ type: "advice.due", workspaceId: "w", finished: 5, at: "t" });
    expect(advice).toBe(
      "- advice.due — project w, 5 requests finished since the last advice. Read its figures with bm_findings; for each finding worth acting on, ask the owner with bm_ask_owner, one option carrying the prepared change. With none worth it, keep a note with bm_note.",
    );
    // What a change may be, and that only the owner's answer applies it, is the tool's own description (bead 81y2.24).
    expect(orchestratorFace("bm_ask_owner").description).toContain("the plugin applies it only when the owner picks it — never on a precedent's, the policy's or your answer");
    expect(orchestratorFace("bm_findings").description).toContain("Figures and short labels only, at most 4,000 characters");
    const decision = eventLineOf({ type: "decision.opened", workspaceId: "w", requestId: "r", decisionId: "q:r:Q1", askedBy: null, asks: "decision" });
    expect(decision).toMatch(/A decision is asked: the owner's policy delegates its class to you\. Read it with bm_decisions and choose the option the owner would, with bm_decide and your reason in one line\.$/);
    const prediction = eventLineOf({ type: "decision.opened", workspaceId: "w", requestId: "r", decisionId: "q:r:Q1", askedBy: null, asks: "prediction" });
    expect(prediction).toMatch(/A prediction is asked: read it with bm_decisions and give the option you expect the owner to choose with bm_predict\. The owner decides it: answer nothing and tell the owner nothing\.$/);
    expect(orchestratorFace("bm_predict").description).toContain("Do not tell the owner what you predicted.");
    expect(O, "no answer to a stored question in a command").not.toMatch(/answer with `bm_direct_worker`|intent `answer`, a `BM-ANSWERS` block/);
    rule(O, "BM-ANSWER carries a grant", /\*\*`BM-ANSWER`\*\* is the owner's answer to one of your decisions, with its grant/);
    rule(O, "carries the answer out with one command passing its decisionId", /carry it out as it says, with one command passing its `decisionId`/);
    // The notice itself names the grant, the decisionId it is spent with, and to act now.
    const answered = {
      id: "o:w:1",
      workspaceId: "w",
      requestId: "req-20260930T000000Z",
      question: "Push the fix?",
      subject: null,
      options: [{ key: "a", label: "Push it", effects: ["push"] }],
      answer: { by: "owner", optionKey: null, words: "Yes, push it.", at: "t" },
      grant: { effects: ["push"], expiresAt: "2026-09-30T01:00:00.000Z", usedAt: null },
    } as unknown as Decision;
    const notice = answerNoticeOf(answered);
    expect(notice).toContain("grant: push, for one command with decisionId o:w:1, until 2026-09-30T01:00:00.000Z");
    expect(notice).toContain("Act on it now");
  });

  it("writes commands as the owner would, never to a Reviewer, and never rewords around a refusal", () => {
    rule(O, "the Manager's language", /in the language of that Manager's chat with the owner/);
    rule(O, "never a Reviewer", /never to a Reviewer/);
    // Part of the authority limit: a refusal is final, and never worked around.
    rule(OR, "a refusal sent nothing", /A refusal means nothing was sent/);
    rule(OR, "never reword", /never reword to get through/);
    // Design §B.9: without a decision, a command goes out on the Orchestrator's own only where the owner delegated its
    // classes — RULES 2 ("a class the owner delegated covers its own", pinned above) and the tool's own description.
    expect(orchestratorFace("bm_send_command").description).toMatch(/Without a decision it goes out on your own only where the owner delegated every class of its effects/);
    // A Worker's question is answered through the decision store, never in a command (change-004): the role keeps
    // `bm_direct_worker` narrower than its description, to corrections only.
    rule(O, "direct commands only correct", /`bm_direct_worker` only for a correction/);
  });

  it("asks the owner with prepared actions, proposing a class, and leaves the rest to bm_ask_owner's description", () => {
    rule(O, "options with effects and a prepared command", /two to five options you can carry out, each with its effects and, to act at once when chosen, a prepared command/);
    rule(O, "names the class it proposes (design §B.1)", /Ask with `bm_ask_owner` what your authority does not cover, proposing its `class`/);
    // One open decision per request, and the replaced id only when the tool names it (bead 81y2.24): the tool says so,
    // and RULES 3 ("you NEVER guess", pinned above) keeps the Orchestrator from claiming a replacement it did not see.
    expect(orchestratorFace("bm_ask_owner").description).toContain("One open question per request: a new one replaces your open question of the same request (the answer names the replaced id) unless separate: true.");
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

  // Bead 81y2.24: the role files no longer repeat these; the plugin's own text carries them.
  it("the Runtime facts say what a mode of `none` means and when to name missing Worker skills", () => {
    expect(runtimeFactsText("manager", { workerModeNone: true })).toContain("Worker mode: none — do not pass `settings.modeId` when you create a Worker");
    expect(runtimeFactsText("manager", { workerModeId: "auto" })).toContain("Worker mode: `auto` — pass it as `settings.modeId` when you create a Worker");
    expect(workerSkillsLine(["polishing-beads"])).toContain("tell the user once, when you confirm the Worker");
  });

  it("the block tools say to fix the listed fields and call again", () => {
    for (const name of ["bm_report", "bm_review", "bm_answers"]) {
      expect(toolNamed(name)?.description, name).toContain("On error, fix the listed fields and call again.");
    }
  });
});
