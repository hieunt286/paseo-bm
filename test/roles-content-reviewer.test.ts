/**
 * Content checks for plugin/roles/reviewer.md (bead bm-wp-116-ti7.1).
 *
 * The Reviewer's behaviour is natural-language instruction, so the local proof
 * is a content test: it must be English, read-only, never fix anything, never
 * create an agent (Design §2.6 C, ADR-006 decision 9), and classify findings as
 * blocking or non-blocking in terms that match worker.md. Whether a real
 * Reviewer behaves this way is WP-117's acceptance, not this.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../plugin/roles/${name}`, import.meta.url)), "utf8");
const text = read("reviewer.md");
const lower = text.toLowerCase();
const worker = read("worker.md");

function section(source: string, heading: string): string {
  const start = source.indexOf(`## ${heading}\n`);
  expect(start, `missing section ${heading}`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\n## ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to === -1 ? undefined : to);
}

describe("roles/reviewer.md content", () => {
  it("is written in English with no Vietnamese diacritics and no placeholder left", () => {
    expect(text).not.toMatch(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i);
    expect(lower).not.toContain("placeholder");
    expect(lower).not.toContain("skeleton");
    expect(text).toMatch(/\b(the|you|and|must|never)\b/);
  });

  it("reviews only the batch it was given, identified by requestId, batchId and scope", () => {
    const role = section(text, "Role");
    expect(role).toContain("`requestId`");
    expect(role).toContain("`batchId`");
    expect(role).toMatch(/\*\*review scope\*\*/);
    expect(role).toMatch(/\*\*one document\*\*/);
    expect(role).toMatch(/\*\*one round of creating or updating beads\*\*/);
    expect(role).toMatch(/\*\*the whole implementation of one bead\*\*/);
    expect(section(text, "Hard boundaries")).toMatch(/\*\*Never widen the review\.\*\*/);
    expect(section(text, "Hard boundaries")).toMatch(/do not ask for another review round/);
  });

  it("is read-only and never fixes anything itself", () => {
    const boundaries = section(text, "Hard boundaries");
    expect(section(text, "Role")).toMatch(/You are \*\*read-only\*\*: you never fix anything/);
    expect(boundaries).toMatch(/\*\*You are read-only\. Never modify files\.\*\*/);
    expect(boundaries).toMatch(/Do not fix a\s+finding yourself/);
    expect(boundaries).toMatch(/\*\*Never change beads\.\*\*/);
    expect(boundaries).toMatch(/\*\*Never run a command that changes state or needs the network\.\*\*/);
  });

  it("never creates or manages an agent, even when the tools are available", () => {
    const boundaries = section(text, "Hard boundaries");
    expect(boundaries).toMatch(/\*\*Never create, prompt, stop, archive or delete any agent\.\*\*/);
    expect(boundaries).toMatch(/Having a tool is never permission to use it/);
    expect(boundaries).toMatch(/stops review from becoming recursive/);
    expect(boundaries).toMatch(/do not\s+call them/);
    expect(section(text, "Stop conditions")).toMatch(/do not start a new agent, and do not restart\s+yourself/);
  });

  it("never touches git or reads secrets", () => {
    const boundaries = section(text, "Hard boundaries");
    expect(boundaries).toMatch(/No commit, no push, no pull request/);
    expect(boundaries).toMatch(/\*\*Never read secrets\.\*\*/);
  });

  it("classifies findings as blocking or non-blocking and derives the verdict from them", () => {
    const workflow = section(text, "Workflow");
    expect(workflow).toMatch(/A finding is \*\*blocking\*\* when/);
    expect(workflow).toMatch(/Everything else is \*\*non-blocking\*\*/);
    const reporting = section(text, "Reporting");
    expect(reporting).toMatch(/`verdict` is `changes-required` when at least one finding is \*\*blocking\*\*/);
    expect(reporting).toMatch(/Non-blocking findings alone never change the verdict/);
  });

  it("returns a fixed structured block with location, reason and suggested fix per finding", () => {
    const block = between(section(text, "Reporting"), "```\nBM-REVIEW", "\n```");
    for (const field of [
      "requestId:",
      "batchId:",
      "reviewKind: first | re-review",
      "verdict: pass | changes-required",
      "checked:",
      "severity: blocking | non-blocking",
      "location: <file:line, or bead id>",
      "reason:",
      "suggestedFix:",
      "notChecked:",
    ]) {
      expect(block, field).toContain(field);
    }
  });

  it("covers the bead, the code diff and the test results together for the Small tier", () => {
    expect(section(text, "Workflow")).toMatch(/\*\*the bead, the\s+code diff and the test results together\*\*/);
    expect(section(text, "Reporting")).toMatch(/`checked` must name the bead, the code diff and the test\s+results/);
  });

  it("checks previous blocking findings first on a re-review of the same batchId", () => {
    expect(section(text, "Workflow")).toMatch(/\*\*re-review\*\* of the same `batchId`, check first that every blocking\s+finding from the previous review is fixed/);
  });

  it("stops when done or when the Worker or the user stops it", () => {
    const stop = section(text, "Stop conditions");
    expect(stop).toMatch(/\*\*After you return the result, stop\.\*\*/);
    expect(stop).toMatch(/\*\*If the Worker or the user stops you, stop immediately\.\*\*/);
  });
});

describe("worker.md agrees with the Reviewer on batches and re-review", () => {
  const batches = between(worker, "### Review batches", "### Guardrail budget");

  it("defines the same three batch kinds and creates the Reviewer with bm-reviewer", () => {
    expect(batches).toMatch(/\*\*one document\*\*/);
    expect(batches).toMatch(/\*\*one round of creating or updating beads\*\*/);
    expect(batches).toMatch(/\*\*the whole implementation of one bead\*\*/);
    expect(batches).toContain("`bm-reviewer`");
    expect(batches).toMatch(/`bm\.role` = `reviewer`/);
    expect(batches).toMatch(/Give it the `requestId`, the\s+`batchId`, and exactly what to review/);
  });

  it("re-reviews the same batch after fixing blocking findings", () => {
    expect(batches).toMatch(/Fix every \*\*blocking\*\* finding, then\s+review the same batch again/);
    expect(batches).toMatch(/\*\*A batch keeps its `batchId` while you fix review findings\.\*\*/);
  });
});
