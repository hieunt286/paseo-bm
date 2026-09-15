/**
 * Content checks for part three of plugin/roles/worker.md (bead
 * bm-wp-115-51j.3): the implementation phase and the six-group safety
 * contract. Behaviour on a real daemon is WP-117's acceptance.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const text = readFileSync(fileURLToPath(new URL("../plugin/roles/worker.md", import.meta.url)), "utf8");

/** Text from `start` up to `end`, or to the end of the file when `end` is undefined or absent. */
function between(start: string, end?: string): string {
  const from = text.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = end === undefined ? -1 : text.indexOf(end, from + start.length);
  return text.slice(from, to === -1 ? undefined : to);
}

const flat = (value: string) => value.replace(/\s+/g, " ");

const boundaries = between("## Hard boundaries", "\n## Workflow");
const implement = between("### Step 5 — Implement until done", "\n## Reporting");
const stops = between("## Stop conditions");

describe("worker.md part three — six-group safety contract", () => {
  it("has all six groups, in order", () => {
    const groups = [
      "### 1. Scope boundary",
      "### 2. Workspace safety",
      "### 3. Side-effect gate",
      "### 4. Progress stop points",
      "### 5. One bead at a time",
      "### 6. Stop and propagate",
    ];
    const positions = groups.map((heading) => boundaries.indexOf(heading));
    for (const [index, position] of positions.entries()) {
      expect(position, groups[index]).toBeGreaterThan(0);
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("keeps to the request's beads and never picks up other ready beads", () => {
    const group = between("### 1. Scope boundary", "### 2.");
    expect(group).toMatch(/original request verbatim/);
    expect(group).toMatch(/label set/);
    expect(group).toMatch(/\*\*Do not pick up other ready beads\*\*/);
  });

  it("snapshots git status, preserves existing changes, never writes outside the workspace and never reads secrets", () => {
    const group = between("### 2. Workspace safety", "### 3.");
    expect(group).toMatch(/\*\*Before your first write, capture `git status`\*\*/);
    expect(group).toMatch(/\*\*Preserve pre-existing changes\.\*\*/);
    expect(group).toMatch(/\*\*Never delete or overwrite a file that does not belong to the bead\*\*/);
    expect(group).toMatch(/\*\*Never write outside this workspace\*\*/);
    expect(group).toMatch(/\*\*Never read secret files\*\*/);
  });

  it("asks before dependencies, network, real-data migrations, deploy/publish and privilege escalation", () => {
    const group = flat(between("### 3. Side-effect gate", "### 4."));
    expect(group).toContain("**Ask the user first, and wait for an explicit yes,**");
    for (const effect of [
      "install or upgrade a dependency",
      "needs the network",
      "migration against real data",
      "deploy or publish",
      "elevated privileges",
    ]) {
      expect(group, effect).toContain(effect);
    }
  });

  it("forbids destructive commands outright rather than ask-then-do", () => {
    const group = flat(between("### 3. Side-effect gate", "### 4."));
    expect(group).toContain("**Destructive commands are forbidden outright — never ask-then-do them.**");
    for (const command of ["`git reset --hard`", "`git clean`", "dropping or truncating databases"]) {
      expect(group).toContain(command);
    }
    expect(group).toContain("the user does it themselves");
  });

  it("stops on no new evidence, repeated errors, contradictory DoD, missing build/test, or scope change", () => {
    const group = between("### 4. Progress stop points", "### 5.");
    for (const trigger of [
      "no new evidence",
      "the same error repeats",
      "Definition of Done contradicts",
      "no build or test command",
      "change the scope",
    ]) {
      expect(group, trigger).toContain(trigger);
    }
  });

  it("works one bead at a time and never closes one with failing tests or unmet DoD", () => {
    const group = between("### 5. One bead at a time", "### 6.");
    expect(group).toMatch(/exactly one bead `in_progress`/);
    expect(group).toMatch(/\*\*Never close a bead while its tests or its Definition of Done are not met\.\*\*/);
  });

  it("stops its Reviewers, spawns nothing and leaves a final report when stopped", () => {
    const group = flat(between("### 6. Stop and propagate", "\n## Workflow"));
    expect(group).toContain("**stop every Reviewer you are running**");
    expect(group).toContain("do not create any new agent");
    expect(group).toContain("`finished` report");
  });

  // Bug bm-wq6: in acceptance run 4, F-8a, Paseo's Stop interrupted only the
  // Worker's turn; its Reviewer kept running and its finish notification woke
  // the Worker again.
  it("recognises an interrupted turn as a stop, cancels running Reviewers and does nothing else (bm-wq6)", () => {
    const group = flat(between("### 6. Stop and propagate", "\n## Workflow"));
    expect(group).toContain("**Recognising a stop.**");
    expect(group).toContain("**stop message**");
    expect(group).toContain("**interrupted with no message** (Paseo's Stop)");
    expect(group).toContain(
      "from a notification that a Reviewer or another agent finished, or with no new instruction from the user — **treat it as a stop** unless the user explicitly asked you to continue.",
    );
    expect(group).toContain("**If it is unclear whether you were stopped, stop and ask the user.**");

    expect(group).toContain("**On a stop,** in this order:");
    expect(group).toContain("**Call Paseo's `cancel_agent` tool on every Reviewer you created that is still running.**");
    expect(group).toContain("**never archive, kill or delete any agent.**");
    expect(group).toContain("**Do nothing else:** create no agent, run no build or test, make no edit, and change no bead.");
    expect(group).toContain("Send the `finished` report described above, then stay idle.");
    expect(group.indexOf("`cancel_agent`")).toBeLessThan(group.indexOf("Send the `finished` report described above"));

    expect(group).toContain("**Finish notifications after a stop are not instructions.**");
    expect(group).toContain("do not continue because of it; at most acknowledge it in one line.");
  });

  it("mirrors the stop rule in Stop conditions (bm-wq6)", () => {
    const condition = flat(stops);
    expect(condition).toContain("including a turn interrupted with no message");
    expect(condition).toContain("cancel your running Reviewers with `cancel_agent` and do nothing else");
    expect(condition).toContain("Later finish notifications from Reviewers do not restart the work.");
  });

  it("forbids git publishing and agent archival, with no hard time or step limit", () => {
    const all = flat(boundaries);
    expect(all).toContain("**no hard limit on time or number of steps**");
    expect(all).toContain("commit, push, or open a pull request");
    expect(all).toContain("archive or delete any agent, including yourself");
  });
});

describe("worker.md part three — implementation phase", () => {
  it("loops over ready beads of the request until all are closed, with evidence and a report each time", () => {
    const steps = [
      /1\. Pick a \*\*ready\*\* bead from this request's list only/,
      /2\. Mark it `in_progress`/,
      /4\. Run the target repository's own build and test commands/,
      /5\. Review the bead's implementation as one batch/,
      /6\. Close the bead with evidence/,
      /7\. Send a `bead-implemented` report/,
    ];
    for (const step of steps) {
      expect(implement).toMatch(step);
    }
    expect(implement).toMatch(/Repeat until every bead of the request is closed/);
    expect(flat(implement)).toContain("send a `finished` report, then stay idle");
  });

  it("orders documents, beads and implementation, and makes Large ask before implementing", () => {
    const step3 = text.indexOf("### Step 3 — Documents");
    const step4 = text.indexOf("### Step 4 — Beads");
    const step5 = text.indexOf("### Step 5 — Implement until done");
    expect(step3).toBeGreaterThan(text.indexOf("### Step 2"));
    expect(step4).toBeGreaterThan(step3);
    expect(step5).toBeGreaterThan(step4);
    expect(text.slice(step4, step5)).toMatch(/\*\*Large:\*\* ask the user to confirm before you start implementing/);
  });

  it("has concrete stop conditions and no placeholder left anywhere in the file", () => {
    expect(stops).toMatch(/every bead of the request is closed/);
    expect(stops).toMatch(/more than one open bead matches/);
    expect(text.toLowerCase()).not.toMatch(/placeholder|to be written/);
  });
});
