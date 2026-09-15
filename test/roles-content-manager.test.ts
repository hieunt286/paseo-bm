/**
 * Content checks for plugin/roles/manager.md (bead bm-wp-114-c0h.1).
 *
 * This file is behaviour written in natural language, so the local proof is a
 * content test: every obligation the bead lists must be stated, and nothing
 * may grant the Manager permission to write documents or create beads. Whether
 * a real Manager actually behaves this way is WP-117's acceptance, not this.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const text = readFileSync(fileURLToPath(new URL("../plugin/roles/manager.md", import.meta.url)), "utf8");
const lower = text.toLowerCase();

function section(heading: string): string {
  const start = text.indexOf(`## ${heading}\n`);
  expect(start, `missing section ${heading}`).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

describe("roles/manager.md content", () => {
  it("is written in English with no Vietnamese diacritics and no placeholder left", () => {
    expect(text).not.toMatch(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i);
    expect(lower).not.toContain("placeholder");
    expect(text).toMatch(/\b(the|you|and|must|never)\b/);
  });

  it("delegates immediately to a Worker instead of doing the work", () => {
    expect(text).toMatch(/delegate immediately/i);
    expect(text).toMatch(/You do not do the work yourself/);
    expect(section("Workflow")).toContain("`bm-worker`");
    expect(section("Workflow")).toMatch(/this same workspace/);
  });

  it("labels the Worker it creates", () => {
    const workflow = section("Workflow");
    expect(workflow).toMatch(/`bm\.role` = `worker`/);
    expect(workflow).toMatch(/`bm\.version`/);
    expect(workflow).toMatch(/requestId/);
  });

  it("names its progress data sources and forbids reading other agents' conversations", () => {
    expect(lower).toContain("structured report");
    expect(lower).toMatch(/status and activity tools/);
    expect(section("Hard boundaries")).toMatch(/Never read another agent's conversation/);
  });

  it("checks the three skills directories against the required list and reminds without blocking", () => {
    const workflow = section("Workflow");
    for (const dir of ["~/.agents/skills", "~/.claude/skills", "~/.codex/skills"]) {
      expect(workflow).toContain(dir);
    }
    for (const skill of ["feature-workflow", "reviewing-plan", "converting-plan-to-beads", "polishing-beads", "implementing-beads"]) {
      expect(workflow).toContain(`\`${skill}\``);
    }
    expect(workflow).toMatch(/continue delegating/i);
    expect(workflow).toContain("npx paseo-bm doctor");
  });

  it("supervises the guardrail budgets per size tier", () => {
    const reporting = section("Reporting");
    expect(reporting).toMatch(/\| Total review \+ polish calls per `requestId` \| \*\*1\*\* \| \*\*6\*\* \| \*\*10\*\* \|/);
    expect(reporting).toMatch(/stop\s+the Worker's current run/);
    expect(reporting).toMatch(/not a code-level\s+block/);
  });

  it("may stop agents but never archive or delete them", () => {
    const boundaries = section("Hard boundaries");
    expect(boundaries).toMatch(/Never archive or delete any agent/);
    expect(boundaries).toMatch(/You may stop \(cancel\)/);
    expect(section("Stop conditions")).toMatch(/do not do it/);
  });

  it("contains no sentence that lets the Manager write documents or create beads", () => {
    expect(section("Hard boundaries")).toMatch(/Never write or edit documents, never create, update or close beads/);
    const sentences = text.split(/(?<=[.!?])\s+|\n/);
    const permissive = sentences.filter(
      (sentence) =>
        /\byou (may|can|should|must)\b/i.test(sentence) &&
        /\b(write|edit|create|update|close)\b[^.]*\b(documents?|docs?|beads?|prd|design|plan)\b/i.test(sentence),
    );
    expect(permissive).toEqual([]);
  });
});
