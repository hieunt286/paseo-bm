/**
 * Content checks for part two of plugin/roles/worker.md (bead bm-wp-115-51j.2):
 * review batches (Design §2.6 C), the behavioural guardrail (§2.6 F) and the
 * structured Worker -> Manager report (§2.6 B). Behaviour on a real daemon is
 * WP-117's acceptance.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../plugin/roles/${name}`, import.meta.url)), "utf8");
const worker = read("worker.md");
const manager = read("manager.md");

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to === -1 ? undefined : to);
}

const batches = between(worker, "### Review batches", "### Guardrail budget");
const guardrail = between(worker, "### Guardrail budget", "### Structured report to Manager");
const report = between(worker, "### Structured report to Manager", "\n## Stop conditions");
const flat = (value: string) => value.replace(/\s+/g, " ");

// Bug bm-fbp: in acceptance run F-1 a third-party skill steered Worker away from
// its role contract. The precedence section must come first and restate the
// four points the skill overrode.
describe("worker.md — role instructions override any skill (bm-fbp)", () => {
  const precedence = between(worker, "### These role instructions override any skill", "\n## Responsibilities");
  const text = flat(precedence);

  it("sits inside ## Role, before Responsibilities and Hard boundaries", () => {
    const at = worker.indexOf("### These role instructions override any skill");
    expect(at).toBeGreaterThan(worker.indexOf("## Role"));
    expect(at).toBeLessThan(worker.indexOf("## Responsibilities"));
    expect(at).toBeLessThan(worker.indexOf("## Hard boundaries"));
  });

  it("says the role file wins over any skill, naming the skills that steered Worker off course", () => {
    expect(text).toContain("**These role instructions override any skill**");
    for (const skill of ["feature-workflow", "implementing-beads", "code-review"]) {
      expect(text, skill).toContain(skill);
    }
    expect(text).toContain("**when a skill suggests something different, follow this file, not the skill.**");
  });

  it("point 1: review counts only through a create_agent Reviewer with profile bm-reviewer, never a skill or self-review", () => {
    expect(text).toContain("A review counts only when you created a Reviewer agent with Paseo's `create_agent` tool");
    expect(text).toContain("agent profile `bm-reviewer` (provider `bm-reviewer/<model of the profile>`)");
    expect(text).toContain("`bm.role` = `reviewer`");
    expect(text).toContain("**Never use a review skill (such as `code-review`) or review the work yourself as a substitute.**");
  });

  it("point 2: Small creates no new document file, not even a feature-workflow quick brief or plan", () => {
    expect(text).toContain("**Small creates no new document file at all**");
    expect(text).toContain("not even the quick brief or quick plan that feature-workflow's lightweight variant suggests");
    expect(text).toContain("Write the classification and the short plan in the bead description instead.");
  });

  it("point 3: every created bead carries feature:<slug>, re-checked before beads-done; extra labels never replace it", () => {
    expect(text).toContain("**Every bead you create carries `feature:<slug>`**");
    expect(text).toContain("`area:<slug>` and `component:<slug>` when you can identify them");
    expect(text).toContain("Check the labels again before you send the `beads-done` report.");
    expect(text).toContain("Extra labels such as `size:*` or the `requestId` are allowed, but they never replace `feature:*`.");
  });

  it("point 4: reports go to Manager's agent id through send_agent_prompt, never SendMessage", () => {
    expect(text).toContain("**Report to Manager with Paseo's `send_agent_prompt` tool**, addressed to Manager's agent id.");
    expect(text).toContain("**Do not use `SendMessage`**");
  });
});

describe("worker.md part two — review batches", () => {
  it("defines a batch as one document, one bead round, or one bead's whole implementation", () => {
    expect(batches).toMatch(/never per file/);
    expect(batches).toMatch(/\*\*one document\*\*/);
    expect(batches).toMatch(/\*\*one round of creating or updating beads\*\*/);
    expect(batches).toMatch(/\*\*the whole implementation of one bead\*\*/);
  });

  it("keeps the batchId while fixing findings, so renaming cannot reset the counter", () => {
    expect(batches).toMatch(/\*\*A batch keeps its `batchId` while you fix review findings\.\*\*/);
    expect(batches).toMatch(/re-review is that batch's second\s+call/);
    expect(batches).toMatch(/Renaming or splitting a batch to get more review calls is not allowed/);
  });

  it("caps review at 2 calls per batch and stops with the remaining findings when exhausted", () => {
    expect(batches).toMatch(/\*\*at most 2 review calls per batch\*\*/);
    expect(batches).toMatch(/\*\*When a batch has used its review calls and blocking findings remain, stop\.\*\*/);
    expect(batches).toMatch(/Do not start a third review/);
    expect(batches).toMatch(/Tell the user which blocking findings are left/);
  });

  it("gives Small exactly one review after implementation and no polish, and caps polish at 1 per bead round", () => {
    expect(batches).toMatch(/\*\*Small:\*\* exactly \*\*one\*\* review call, \*\*after implementation\*\*/);
    expect(batches).toMatch(/and no polish/);
    expect(batches).toMatch(/at most \*\*1 polish call per round of creating or updating beads\*\*/);
  });

  it("counts every review request as one call and exempts read-only actions", () => {
    expect(batches).toMatch(/counts as \*\*one call\*\*, whether you create a new\s+Reviewer or reuse the same one/);
    expect(batches).toMatch(/Read-only actions[^.]*never trigger a review/);
    expect(batches).toContain("`bm-reviewer`");
    expect(batches).toMatch(/`bm\.role` = `reviewer`/);
  });

  it("creates the Reviewer with create_agent and profile bm-reviewer, and never counts a review skill or self-review (bm-fbp)", () => {
    const text = flat(batches);
    expect(text).toContain(
      "create a Reviewer agent in this workspace with Paseo's `create_agent` tool, using the agent profile `bm-reviewer` (provider `bm-reviewer/<model of the profile>`)",
    );
    expect(text).toContain("**Only a review by that Reviewer agent counts.**");
    expect(text).toContain(
      "A review skill (such as `code-review`) or reviewing the work yourself is never a substitute and never counts as a review call.",
    );
  });

  it("always sets settings.modeId, from the profile or the first safe mode of inspect_provider (bm-cvr)", () => {
    const text = flat(batches);
    expect(text).toContain("Always set `settings.modeId`: a call without it can fail.");
    expect(text).toContain("call `inspect_provider` **once** for `bm-reviewer`");
    expect(text).toContain("the first mode whose `colorTier` is `safe`; if none is `safe`, use the first `moderate` one.");
    expect(text).toContain("Never pick a `planning` or `dangerous` mode");
  });
});

describe("worker.md part two — guardrail", () => {
  it("names itself a behavioural guardrail rather than a code-level block", () => {
    expect(guardrail).toMatch(/\*\*behavioural guardrail, not a code-level block\*\*/);
  });

  it("uses the per-tier budget of Design §2.6 F, identical to Manager's table", () => {
    const totalRow = "| **Total review + polish calls per `requestId`** | **1** | **6** | **10** |";
    expect(guardrail).toContain(totalRow);
    expect(guardrail).toContain("| Review calls per batch | 1, after implementation | at most 2 | at most 2 |");
    expect(guardrail).toContain("| Polish calls per bead round | 0 | at most 1 | at most 1 |");
    expect(manager).toMatch(/\| Total review \+ polish calls per `requestId` \| \*\*1\*\* \| \*\*6\*\* \| \*\*10\*\* \|/);
  });

  it("asks the user before exceeding the budget and treats allowed calls as valid", () => {
    expect(guardrail).toMatch(/\*\*ask the user\*\*\s+and wait/);
    expect(guardrail).toMatch(/Calls the user\s+allowed are valid/);
  });
});

describe("worker.md part two — structured report", () => {
  const block = between(report, "```\nBM-REPORT", "\n```");

  it("is sent at every milestone of Design §2.6 B", () => {
    for (const milestone of ["received", "documents-done", "beads-done", "bead-implemented", "blocked", "finished"]) {
      expect(report).toContain(`\`${milestone}\``);
    }
    expect(report).toMatch(/Manager cannot read your conversation/);
  });

  it("is sent to Manager's agent id with send_agent_prompt, never SendMessage (bm-fbp)", () => {
    const text = flat(report);
    expect(text).toContain("Send the report to Manager's agent id (given in your initial prompt) with Paseo's `send_agent_prompt` tool.");
    expect(text).toContain("**Do not use `SendMessage`**");
    expect(text).not.toContain("send-prompt tool");
  });

  it("carries every required field including requestId and the guardrail counters", () => {
    for (const field of [
      "requestId:",
      "phase:",
      "tier:",
      "filesChanged:",
      "beadsCreated:",
      "beadsUpdated:",
      "beadsClosed:",
      "beadsReady:",
      "reviewFindingsOpen:",
      "buildAndTests:",
      "blockers:",
      "guardrail:",
    ]) {
      expect(block, field).toContain(field);
    }
    expect(block).toMatch(/guardrail: batch <batchId> reviews <n>\/<max>; polish <n>\/<max>; total <n>\/<budget>/);
  });

  it("matches the fields Manager expects to receive", () => {
    const managerReporting = between(manager, "**What the Worker sends you.**", "**How you answer the user.**");
    for (const expectation of ["requestId", "size tier", "files changed", "beads created, updated and closed", "beads ready", "remaining review findings", "build and test status", "blockers", "guardrail counters"]) {
      expect(managerReporting.toLowerCase(), expectation).toContain(expectation.toLowerCase());
    }
  });
});
