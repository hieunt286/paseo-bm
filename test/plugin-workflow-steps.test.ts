import { describe, expect, it } from "vitest";
import {
  SKIPPABLE_BY_TIER,
  WORKFLOW_STEPS,
  inferWorkflowSteps,
  workspacePath,
} from "../plugin/server/workflow-steps";
import { reconstructTraces, type AgentFacts } from "../plugin/server/traces";
import { TRACE_STORE_SCHEMA_VERSION, type Evidence, type TraceRecord } from "../plugin/shared/contracts";

/**
 * WP-207: the feature-workflow table.
 *
 * The two rules this file exists to protect: "done" always has evidence, and
 * "skipped" is only ever said when the Worker itself reported a tier that
 * REQ-036 lets omit that step. Everything else is "unknown", and that is a
 * correct answer, not a gap.
 */

const WS = "wks_1";
const MANAGER = "agent-manager";

function record(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: "2026-09-16T10:00:00.000Z",
    workspaceId: WS,
    agentId: MANAGER,
    role: "manager",
    turnId: "turn-1",
    requestId: "req-A",
    parentAgentId: null,
    agentCreatedAt: null,
    startedAt: null,
    endedAt: "2026-09-16T10:00:00.000Z",
    outcome: "completed",
    sent: [],
    received: [],
    reports: [],
    reviews: [],
    evidence: [],
    usage: null,
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "w1",
    at: "2026-09-16T10:10:00.000Z",
    requestId: "req-A",
    phase: null,
    tier: null,
    filesChanged: [],
    beadsCreated: [],
    beadsUpdated: [],
    beadsClosed: [],
    beadsReady: [],
    reviewFindingsOpen: null,
    buildAndTests: null,
    blockers: null,
    guardrail: null,
    unparsedFields: [],
    incompleteFields: [],
    skillsUsed: [],
    ...overrides,
  };
}

const shell = (detail: string): Evidence => ({ kind: "shell", detail, agentId: "w1", at: "2026-09-16T10:09:00.000Z" });
const file = (detail: string): Evidence => ({ kind: "file", detail, agentId: "w1", at: "2026-09-16T10:09:00.000Z" });

function agent(overrides: Partial<AgentFacts> & { id: string }): AgentFacts {
  return {
    role: "worker",
    status: "idle",
    parentAgentId: MANAGER,
    createdAt: "2026-09-16T10:00:10.000Z",
    requestIdLabel: "req-A",
    batchIdLabel: null,
    archived: false,
    ...overrides,
  };
}

/** A trace with one Manager request and one Worker turn carrying `worker`. */
function traceWith(worker: Partial<TraceRecord>, agents: AgentFacts[] = [agent({ id: "w1" })]) {
  const records = [
    record({ sent: [{ agentId: MANAGER, at: "2026-09-16T10:00:00.000Z", text: "a request", truncated: false }] }),
    record({ agentId: "w1", role: "worker", turnId: "w-turn", at: "2026-09-16T10:10:00.000Z", ...worker }),
  ];
  return reconstructTraces({ records, agents })[0]!;
}

const rowFor = (steps: ReturnType<typeof inferWorkflowSteps>, step: string) =>
  steps.find((row) => row.step === step)!;

describe("table shape", () => {
  it("always returns all twelve steps in order, review_plan right after plan (delta 20260917-workflow-skills)", () => {
    const steps = inferWorkflowSteps(traceWith({}));
    expect(steps.map((row) => row.step)).toEqual([...WORKFLOW_STEPS]);
    expect(steps).toHaveLength(12);
    expect(WORKFLOW_STEPS.indexOf("review_plan")).toBe(WORKFLOW_STEPS.indexOf("plan") + 1);
  });

  it("marks everything unknown when the Worker reported nothing", () => {
    const steps = inferWorkflowSteps(traceWith({}));
    expect(steps.every((row) => row.status === "unknown")).toBe(true);
    expect(rowFor(steps, "prd").note).toContain("no tier was reported");
  });
});

describe("exact evidence from reports", () => {
  it.each([
    ["prd", "docs/product/x-prd.md"],
    ["design", "docs/design/x.md"],
    ["adr", "docs/adr/ADR-009-x.md"],
    ["plan", "docs/plans/x-plan.md"],
  ])("marks %s done from filesChanged", (step, path) => {
    const steps = inferWorkflowSteps(traceWith({ reports: [report({ filesChanged: [path] })] }));
    const row = rowFor(steps, step);
    expect(row.status).toBe("done");
    expect(row.confidence).toBe("exact");
    expect(row.evidence[0]?.detail).toContain(path);
  });

  it("marks the tier, beads, polish, implement, tests and close steps from report fields", () => {
    const guardrail = {
      batchId: "batch-1",
      batchReviews: 1,
      batchMax: 2,
      polish: 1,
      polishMax: 1,
      total: 3,
      budget: 6,
      userAllowedExtra: 0,
      raw: "batch batch-1 reviews 1/2; polish 1/1; total 3/6; userAllowedExtra 0",
    };
    const steps = inferWorkflowSteps(
      traceWith({
        reports: [
          report({ tier: "Large", beadsCreated: ["bm-a1"], guardrail }),
          report({ phase: "bead-implemented", buildAndTests: "npm test - pass", beadsClosed: ["bm-a1"] }),
        ],
      }),
      { beadStatus: (id) => (id === "bm-a1" ? "closed" : null) },
    );
    expect(rowFor(steps, "classify_tier")).toMatchObject({ status: "done", confidence: "exact" });
    expect(rowFor(steps, "convert_to_beads").evidence[0]?.detail).toContain("beadsCreated bm-a1");
    expect(rowFor(steps, "polish_beads").evidence[0]?.detail).toContain("polish 1/1");
    expect(rowFor(steps, "implement").evidence[0]?.detail).toContain("bead-implemented");
    expect(rowFor(steps, "build_and_tests").evidence[0]?.detail).toContain("npm test");
    expect(rowFor(steps, "close_with_evidence").evidence[0]?.detail).toContain("confirmed closed in the store");
  });

  it("does not count buildAndTests: not run as done", () => {
    const steps = inferWorkflowSteps(traceWith({ reports: [report({ buildAndTests: "not run" })] }));
    expect(rowFor(steps, "build_and_tests").status).toBe("unknown");
  });
});

describe("inferred evidence from the timeline", () => {
  it.each([
    ["prd", file("docs/product/x-prd.md")],
    ["design", file("docs/design/x.md")],
    ["convert_to_beads", shell("br create --title=x")],
    ["implement", file("src/app.ts")],
    ["build_and_tests", shell("npm test")],
    ["close_with_evidence", shell("br close bm-a1 --reason=done")],
  ])("marks %s done and inferred", (step, evidence) => {
    const steps = inferWorkflowSteps(traceWith({ evidence: [evidence] }));
    const row = rowFor(steps, step);
    expect(row.status).toBe("done");
    expect(row.confidence).toBe("inferred");
  });

  it("infers polish only from several br update calls in one turn", () => {
    const one = inferWorkflowSteps(traceWith({ evidence: [shell("br update bm-a1 --status=open")] }));
    expect(rowFor(one, "polish_beads").status).toBe("unknown");

    const many = inferWorkflowSteps(
      traceWith({ evidence: [shell("br update bm-a1 --title=x"), shell("br update bm-b2 --title=y")] }),
    );
    expect(rowFor(many, "polish_beads")).toMatchObject({ status: "done", confidence: "inferred" });
  });

  describe("absolute file evidence is read against the workspace directory (delta 20260917-workflow-skills §5.5)", () => {
    const ws = "/Users/test/repo";
    const infer = (paths: string[], workspaceDir: string | null) =>
      inferWorkflowSteps(traceWith({ evidence: paths.map(file) }), { workspaceDir });

    it("counts a document write as the document step, not as implementation", () => {
      const steps = infer([`${ws}/docs/design/x.md`], ws);
      expect(rowFor(steps, "design")).toMatchObject({ status: "done", confidence: "inferred" });
      expect(rowFor(steps, "implement").status).toBe("unknown");
    });

    it("counts a source write inside the workspace as implementation, but not the bead store", () => {
      expect(rowFor(infer([`${ws}/src/a.js`], ws), "implement")).toMatchObject({ status: "done", confidence: "inferred" });
      expect(rowFor(infer([`${ws}/.beads/issues.jsonl`], ws), "implement").status).toBe("unknown");
    });

    it("ignores writes outside the workspace, including a sibling with the same prefix and ~ paths", () => {
      const steps = infer(["/other/src/a.js", `${ws}2/src/a.js`, `${ws}/../other/src/a.js`, "~/.claude/projects/x/memory/y.md"], ws);
      expect(rowFor(steps, "implement").status).toBe("unknown");
    });

    it("ignores absolute paths when the workspace directory is unknown, but keeps relative ones", () => {
      expect(rowFor(infer([`${ws}/src/a.js`], null), "implement").status).toBe("unknown");
      expect(rowFor(infer(["./src/a.js"], null), "implement")).toMatchObject({ status: "done", confidence: "inferred" });
    });

    it("normalises relative paths and rejects ones that leave the workspace (review bm-wp-220-nvk.1)", () => {
      const steps = infer(["src/../docs/design/x.md"], null);
      expect(rowFor(steps, "design")).toMatchObject({ status: "done", confidence: "inferred" });
      expect(rowFor(steps, "implement").status).toBe("unknown");
      expect(rowFor(infer(["../outside/a.js", "src/../../x.js"], null), "implement").status).toBe("unknown");
      expect(workspacePath("./src/a.js", null)).toBe("src/a.js");
    });

    it("normalises paths the same way on its own", () => {
      expect(workspacePath(`${ws}/docs/x.md`, `${ws}/`)).toBe("docs/x.md");
      expect(workspacePath(ws, ws)).toBeNull();
      expect(workspacePath("docs/x.md", null)).toBe("docs/x.md");
    });
  });

  it("does not treat a docs write or a bead file as implementation", () => {
    const steps = inferWorkflowSteps(traceWith({ evidence: [file("docs/design/x.md"), file(".beads/issues.jsonl")] }));
    expect(rowFor(steps, "implement").status).toBe("unknown");
  });

  it("marks review from a BM-REVIEW, and infers it from a Reviewer that merely exists", () => {
    const withReview = traceWith(
      {
        reviews: [{ agentId: "rev-1", at: "2026-09-16T10:09:00.000Z", batchId: "batch-1", verdict: "approved", blockingCount: null }],
      },
      [agent({ id: "w1" }), agent({ id: "rev-1", role: "reviewer", parentAgentId: "w1" })],
    );
    // The review record has to belong to the Reviewer agent for the exact path.
    const exactSteps = inferWorkflowSteps({ ...withReview, reviews: withReview.reviews, reviewerIds: ["rev-1"] });
    expect(rowFor(exactSteps, "review_batches")).toMatchObject({ status: "done", confidence: "exact" });

    const inferredSteps = inferWorkflowSteps({ ...withReview, reviews: [], reviewerIds: ["rev-1"] });
    expect(rowFor(inferredSteps, "review_batches")).toMatchObject({ status: "done", confidence: "inferred" });
  });
});

describe("review_plan (delta 20260917-workflow-skills §5.5)", () => {
  const skill = (detail: string, agentId = "w1"): Evidence => ({ kind: "skill", detail, agentId, at: "2026-09-16T10:05:00.000Z" });

  it("is exact when a report lists reviewing-plan in skillsUsed", () => {
    const steps = inferWorkflowSteps(traceWith({ reports: [report({ phase: "beads-done", tier: "Large", skillsUsed: ["feature-workflow", "reviewing-plan"] })] }));
    expect(rowFor(steps, "review_plan")).toMatchObject({ status: "done", confidence: "exact" });
  });

  it("is inferred from the Worker's or a Reviewer's skill evidence", () => {
    const fromWorker = inferWorkflowSteps(traceWith({ evidence: [skill("reviewing-plan")] }));
    expect(rowFor(fromWorker, "review_plan")).toMatchObject({ status: "done", confidence: "inferred" });
    const agents = [agent({ id: "w1" }), agent({ id: "r1", role: "reviewer", parentAgentId: "w1", batchIdLabel: "b1" })];
    const records = [
      record({ sent: [{ agentId: MANAGER, at: "2026-09-16T10:00:00.000Z", text: "a request", truncated: false }] }),
      record({ agentId: "w1", role: "worker", turnId: "w-turn", at: "2026-09-16T10:10:00.000Z" }),
      record({ agentId: "r1", role: "reviewer", turnId: "r-turn", at: "2026-09-16T10:12:00.000Z", evidence: [skill("reviewing-plan", "r1")] }),
    ];
    const fromReviewer = inferWorkflowSteps(reconstructTraces({ records, agents })[0]!);
    expect(rowFor(fromReviewer, "review_plan")).toMatchObject({ status: "done", confidence: "inferred" });
  });

  it("ignores the Manager's skill check", () => {
    const records = [
      record({
        sent: [{ agentId: MANAGER, at: "2026-09-16T10:00:00.000Z", text: "a request", truncated: false }],
        evidence: [skill("reviewing-plan", MANAGER)],
      }),
      record({ agentId: "w1", role: "worker", turnId: "w-turn", at: "2026-09-16T10:10:00.000Z", reports: [report({ tier: null })] }),
    ];
    // No tier: since PRD delta 20260924-worker-autonomy every tier may omit
    // this step, so only a trace without a tier still shows what this test is
    // about (the evidence rule, not the tier rule).
    const steps = inferWorkflowSteps(reconstructTraces({ records, agents: [agent({ id: "w1" })] })[0]!);
    expect(rowFor(steps, "review_plan").status).toBe("unknown");
  });

  it("is skipped with a note when a Large finished report lists skills without reviewing-plan", () => {
    const steps = inferWorkflowSteps(
      traceWith({ reports: [report({ phase: "finished", tier: "Large", skillsUsed: ["feature-workflow", "polishing-beads"] })] }),
    );
    const row = rowFor(steps, "review_plan");
    expect(row).toMatchObject({ status: "skipped", confidence: "exact" });
    expect(row.note).toContain("without reviewing-plan");
  });

  it("says skipped when the Worker's finished report lacks it, even if a Reviewer loaded reviewing-plan as criteria (review bm-wp-220-nvk.1, B1)", () => {
    const agents = [agent({ id: "w1" }), agent({ id: "r1", role: "reviewer", parentAgentId: "w1", batchIdLabel: "b1" })];
    const records = [
      record({ sent: [{ agentId: MANAGER, at: "2026-09-16T10:00:00.000Z", text: "a request", truncated: false }] }),
      record({
        agentId: "w1",
        role: "worker",
        turnId: "w-turn",
        at: "2026-09-16T10:30:00.000Z",
        reports: [report({ phase: "finished", tier: "Large", skillsUsed: ["feature-workflow", "converting-plan-to-beads", "polishing-beads", "implementing-beads"] })],
      }),
      record({ agentId: "r1", role: "reviewer", turnId: "r-turn", at: "2026-09-16T10:12:00.000Z", evidence: [skill("reviewing-plan", "r1")] }),
    ];
    const steps = inferWorkflowSteps(reconstructTraces({ records, agents })[0]!);
    expect(rowFor(steps, "review_plan")).toMatchObject({ status: "skipped", confidence: "exact" });
  });

  it("draws no negative from a skillsUsed the parser could not fully read (review bm-wp-220-nvk.1, B2)", () => {
    const steps = inferWorkflowSteps(
      traceWith({
        reports: [
          report({ phase: "finished", tier: null, skillsUsed: ["feature-workflow"], incompleteFields: ["skillsUsed"] }),
        ],
      }),
    );
    expect(rowFor(steps, "review_plan").status).toBe("unknown");
    expect(rowFor(steps, "polish_beads").status).toBe("unknown");
  });

  it("lets an unreadable latest finished report stop an older report's negative (re-review of bm-wp-220-nvk.1)", () => {
    const steps = inferWorkflowSteps(
      traceWith({
        reports: [
          report({ phase: "finished", tier: null, at: "2026-09-16T10:10:00.000Z", skillsUsed: ["feature-workflow"] }),
          report({ phase: "finished", tier: null, at: "2026-09-16T10:40:00.000Z", skillsUsed: [], incompleteFields: ["skillsUsed"] }),
        ],
      }),
    );
    expect(rowFor(steps, "review_plan").status).toBe("unknown");
    expect(rowFor(steps, "polish_beads").status).toBe("unknown");
  });

  it("may be skipped by every tier (PRD delta 20260924-worker-autonomy), and stays unknown without a tier", () => {
    for (const tier of ["Small", "Medium", "Large"] as const) {
      const steps = inferWorkflowSteps(traceWith({ reports: [report({ tier })] }));
      expect(rowFor(steps, "review_plan").status, tier).toBe("skipped");
    }
    const untiered = inferWorkflowSteps(traceWith({ reports: [report({ tier: null })] }));
    expect(rowFor(untiered, "review_plan").status).toBe("unknown");
  });
});

describe("skill evidence for convert, polish and implement (delta 20260917-workflow-skills §5.5)", () => {
  const skill = (detail: string): Evidence => ({ kind: "skill", detail, agentId: "w1", at: "2026-09-16T10:05:00.000Z" });
  const newGuardrail = {
    batchId: "b1",
    reviews: 1,
    reviewsMax: 1,
    polish: null,
    polishMax: null,
    total: 1,
    budget: 4,
    userAllowedExtra: 0,
    raw: "batch b1 reviews 1/1; total 1/4; userAllowedExtra 0",
  };

  it("does not read a guardrail without a polish segment as polish skipped", () => {
    const steps = inferWorkflowSteps(traceWith({ reports: [report({ tier: null, guardrail: newGuardrail })] }));
    expect(rowFor(steps, "polish_beads").status).toBe("unknown");
  });

  it("marks polish done from skillsUsed (exact) or a skill load (inferred)", () => {
    const reported = inferWorkflowSteps(traceWith({ reports: [report({ tier: "Large", guardrail: newGuardrail, skillsUsed: ["polishing-beads"] })] }));
    expect(rowFor(reported, "polish_beads")).toMatchObject({ status: "done", confidence: "exact" });
    const loaded = inferWorkflowSteps(traceWith({ reports: [report({ tier: "Large" })], evidence: [skill("polishing-beads")] }));
    expect(rowFor(loaded, "polish_beads")).toMatchObject({ status: "done", confidence: "inferred" });
  });

  it("says polish was skipped, with a note, when a Large finished report lists skills without it", () => {
    const steps = inferWorkflowSteps(
      traceWith({
        reports: [report({ phase: "finished", tier: "Large", skillsUsed: ["feature-workflow", "reviewing-plan", "implementing-beads"] })],
        evidence: [shell("br update bm-a1 -d x"), shell("br update bm-b2 -d y")],
      }),
    );
    const polish = rowFor(steps, "polish_beads");
    expect(polish).toMatchObject({ status: "skipped", confidence: "exact" });
    expect(polish.note).toContain("without polishing-beads");
  });

  it("keeps convert_to_beads done for hand-made Medium beads without the converter", () => {
    const steps = inferWorkflowSteps(
      traceWith({ reports: [report({ phase: "finished", tier: "Medium", beadsCreated: ["bm-a1"], skillsUsed: ["feature-workflow", "polishing-beads", "implementing-beads"] })] }),
    );
    expect(rowFor(steps, "convert_to_beads")).toMatchObject({ status: "done", confidence: "exact" });
  });

  it("marks convert_to_beads from the converter skill", () => {
    const reported = inferWorkflowSteps(traceWith({ reports: [report({ tier: "Large", skillsUsed: ["converting-plan-to-beads"] })] }));
    expect(rowFor(reported, "convert_to_beads")).toMatchObject({ status: "done", confidence: "exact" });
    const loaded = inferWorkflowSteps(traceWith({ reports: [report({ tier: "Large" })], evidence: [skill("converting-plan-to-beads")] }));
    expect(rowFor(loaded, "convert_to_beads")).toMatchObject({ status: "done", confidence: "inferred" });
  });

  it("marks implement exact from skillsUsed, and never skipped for a missing skill", () => {
    const reported = inferWorkflowSteps(traceWith({ reports: [report({ tier: "Medium", skillsUsed: ["implementing-beads"] })] }));
    expect(rowFor(reported, "implement")).toMatchObject({ status: "done", confidence: "exact" });
    const without = inferWorkflowSteps(traceWith({ reports: [report({ phase: "finished", tier: "Small", skillsUsed: ["feature-workflow"] })] }));
    expect(rowFor(without, "implement").status).toBe("unknown");
  });

  it("lets any tier skip polish without any signal (PRD delta 20260924-worker-autonomy), but not an untiered request", () => {
    for (const tier of ["Small", "Medium", "Large"] as const) {
      expect(rowFor(inferWorkflowSteps(traceWith({ reports: [report({ tier })] })), "polish_beads").status, tier).toBe("skipped");
    }
    expect(rowFor(inferWorkflowSteps(traceWith({ reports: [report({ tier: null })] })), "polish_beads").status).toBe("unknown");
  });
});

describe("the skipped rule (REQ-045d)", () => {
  it("lets a Small request skip the document steps and polish", () => {
    const steps = inferWorkflowSteps(traceWith({ reports: [report({ tier: "Small" })] }));
    for (const step of SKIPPABLE_BY_TIER.Small) {
      expect(rowFor(steps, step)).toMatchObject({ status: "skipped", confidence: "exact" });
      expect(rowFor(steps, step).note).toContain("tier Small");
    }
    // Steps a Small request may not skip stay unknown, not skipped.
    expect(rowFor(steps, "convert_to_beads").status).toBe("unknown");
    expect(rowFor(steps, "implement").status).toBe("unknown");
  });

  // PRD delta 20260924-worker-autonomy (REQ-045d): documents follow the change,
  // not the tier, so Medium and Large may omit exactly what Small may.
  it("lets Medium and Large skip the same steps as Small, and nothing else", () => {
    expect(SKIPPABLE_BY_TIER.Medium).toEqual(SKIPPABLE_BY_TIER.Small);
    expect(SKIPPABLE_BY_TIER.Large).toEqual(SKIPPABLE_BY_TIER.Small);
    for (const tier of ["Medium", "Large"] as const) {
      const steps = inferWorkflowSteps(traceWith({ reports: [report({ tier })] }));
      for (const step of ["prd", "design", "adr", "plan", "review_plan", "polish_beads"]) {
        expect(rowFor(steps, step), `${tier} ${step}`).toMatchObject({ status: "skipped", confidence: "exact" });
      }
      for (const step of ["convert_to_beads", "implement", "review_batches", "build_and_tests", "close_with_evidence"]) {
        expect(rowFor(steps, step).status, `${tier} ${step}`).not.toBe("skipped");
      }
    }
  });

  it("never says skipped without a reported tier", () => {
    const steps = inferWorkflowSteps(traceWith({ evidence: [shell("br create --title=x")] }));
    expect(steps.some((row) => row.status === "skipped")).toBe(false);
  });

  it("prefers done over skipped when a Small request did the step anyway", () => {
    const steps = inferWorkflowSteps(
      traceWith({ reports: [report({ tier: "Small", filesChanged: ["docs/design/x.md"] })] }),
    );
    expect(rowFor(steps, "design").status).toBe("done");
    expect(rowFor(steps, "prd").status).toBe("skipped");
  });
});

describe("false positives the WP-214 acceptance run found", () => {
  it("does not treat `br create --help` as creating a bead", () => {
    const steps = inferWorkflowSteps(traceWith({ evidence: [shell("br create --help 2>&1 | head -40")] }));
    expect(rowFor(steps, "convert_to_beads").status).toBe("unknown");
  });

  it("does not treat a dry run as doing the step", () => {
    const steps = inferWorkflowSteps(
      traceWith({ evidence: [shell("br create --dry-run --title=x"), shell("br close --help")] }),
    );
    expect(rowFor(steps, "convert_to_beads").status).toBe("unknown");
    expect(rowFor(steps, "close_with_evidence").status).toBe("unknown");
  });

  it("lets a finished report's empty list outrank an inferred shell signal", () => {
    // The Worker finished and said it created nothing; a br create in the log
    // was therefore something else.
    const steps = inferWorkflowSteps(
      traceWith({
        reports: [report({ phase: "finished", beadsCreated: [] })],
        evidence: [shell("br create --title=x")],
      }),
    );
    expect(rowFor(steps, "convert_to_beads").status).toBe("unknown");
  });

  it("still reports done when the finished report names the beads", () => {
    const steps = inferWorkflowSteps(
      traceWith({ reports: [report({ phase: "finished", beadsCreated: ["bm-a1"] })] }),
    );
    expect(rowFor(steps, "convert_to_beads")).toMatchObject({ status: "done", confidence: "exact" });
  });

  it.each([
    "not run",
    "not run — NOTE: the repository has no build or test command",
    "none",
    "n/a",
    "skipped",
    "no tests in this repo",
  ])("does not count buildAndTests %o as a run", (value) => {
    const steps = inferWorkflowSteps(traceWith({ reports: [report({ buildAndTests: value })] }));
    expect(rowFor(steps, "build_and_tests").status).toBe("unknown");
  });

  it("does not treat a search for test tooling as running tests", () => {
    const steps = inferWorkflowSteps(
      traceWith({
        evidence: [
          shell("echo \"=== build/test files ===\" && ls -a | grep -iE 'makefile|pyproject|pytest|tox' || echo none"),
        ],
      }),
    );
    expect(rowFor(steps, "build_and_tests").status).toBe("unknown");
  });

  it.each([
    "npm test",
    "npm run lint && npm test",
    "cd repo && pytest -q",
    "python3 -m py_compile src/invoice.py",
    "make check",
  ])("counts %o as a real run", (command) => {
    const steps = inferWorkflowSteps(traceWith({ evidence: [shell(command)] }));
    expect(rowFor(steps, "build_and_tests")).toMatchObject({ status: "done", confidence: "inferred" });
  });

  it("counts a real build or test line", () => {
    const steps = inferWorkflowSteps(
      traceWith({ reports: [report({ buildAndTests: "npm test — 1559 passed" })] }),
    );
    expect(rowFor(steps, "build_and_tests")).toMatchObject({ status: "done", confidence: "exact" });
  });
});

describe("the two invariants D-5 measures", () => {
  it("every done row carries at least one piece of evidence", () => {
    const steps = inferWorkflowSteps(
      traceWith({
        reports: [report({ tier: "Large", beadsCreated: ["bm-a1"], filesChanged: ["docs/plans/p.md"] })],
        evidence: [shell("npm test"), file("src/a.ts")],
      }),
    );
    for (const row of steps.filter((candidate) => candidate.status === "done")) {
      expect(row.evidence.length).toBeGreaterThan(0);
    }
  });

  it("no row is skipped unless its tier permits it", () => {
    for (const tier of ["Small", "Medium", "Large"] as const) {
      const steps = inferWorkflowSteps(traceWith({ reports: [report({ tier })] }));
      for (const row of steps.filter((candidate) => candidate.status === "skipped")) {
        expect(SKIPPABLE_BY_TIER[tier]).toContain(row.step);
      }
    }
  });
});

/**
 * WP-214 acceptance, defect 12: F-1 was a **Small** request, where `worker.md`
 * forbids any polish call, and the Worker reported `polish 0/0`. The table
 * still said "Beads polished: Done (inferred)", because it read three
 * `br update` calls on the SAME bead as a polish pass.
 */
describe("polish is not inferred from repeated updates to one bead", () => {
  const guardrail = (polish: number) => ({
    batchId: "b1",
    reviews: 1,
    reviewsMax: 2,
    polish,
    polishMax: 1,
    total: 1,
    budget: 10,
    userAllowedExtra: 0,
    raw: `batch b1 reviews 1/2; polish ${polish}/1; total 1/10; userAllowedExtra 0`,
  });

  it("three updates to one bead are ordinary work, not a polish pass", () => {
    // Verbatim from the acceptance store.
    const steps = inferWorkflowSteps(
      traceWith({
        reports: [report({ tier: "Small" })],
        evidence: [
          shell(`br update repo-37g -d "$(cat <<'EOF' ## Objective ... EOF)"`),
          shell(`br update repo-37g --description "$(cat <<'EOF' ## Objective ... EOF)"`),
          shell("br update repo-37g -s in_progress 2>&1 | tail -2"),
        ],
      }),
    );
    expect(rowFor(steps, "polish_beads").status).not.toBe("done");
  });

  it("a guardrail reporting polish 0 is an exact negative and outranks the timeline", () => {
    const steps = inferWorkflowSteps(
      traceWith({
        // Large may skip nothing, so without the exact negative two
        // distinct-bead updates would read as "done (inferred)".
        reports: [report({ tier: "Large", guardrail: guardrail(0) })],
        evidence: [shell("br update bm-a1 -s in_progress"), shell("br update bm-b2 -s in_progress")],
      }),
    );
    const polish = rowFor(steps, "polish_beads");
    expect(polish.status).toBe("skipped");
    expect(polish.confidence).toBe("exact");
    expect(polish.note).toContain("polish 0/1");
  });

  it("updates across two beads in one turn are still a polish pass", () => {
    const steps = inferWorkflowSteps(
      traceWith({
        reports: [report({ tier: "Medium" })],
        evidence: [shell("br update bm-a1 -d 'x'"), shell("br update bm-b2 -d 'y'")],
      }),
    );
    const polish = rowFor(steps, "polish_beads");
    expect(polish.status).toBe("done");
    expect(polish.confidence).toBe("inferred");
  });
});
