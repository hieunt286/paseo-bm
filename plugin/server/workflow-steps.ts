/**
 * Which feature-workflow steps a request actually went through
 * (WP-207, Dashboard Design §8, REQ-045).
 *
 * This is the only place in the product that judges an agent's process, so it
 * is built around one asymmetry: saying "done" without evidence makes a bad run
 * look good, and saying "skipped" without grounds accuses a good run. Hence
 * three states and one rule each:
 *
 * - **done** needs at least one concrete piece of evidence;
 * - **skipped** needs the Worker's own tier statement AND REQ-036 permitting
 *   that tier to omit that step;
 * - **unknown** is everything else, and it is not a failure of this module —
 *   it is the honest answer when the Worker said nothing.
 *
 * `exact` evidence comes from a `BM-REPORT` field; `inferred` evidence comes
 * from what the timeline shows (a `br` command, a written file, a Reviewer that
 * exists). Both are returned with the row so the user can judge for themselves.
 */
import type {
  Confidence,
  Evidence,
  ParsedReport,
  Tier,
  TraceRecord,
  WorkflowStep,
  WorkflowStepResult,
} from "../shared/contracts";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { brActions, commandSegments, type BrVerb } from "./shell";
import { byAt } from "../shared/order";
import type { ReconstructedTrace } from "./traces";

/** The twelve steps, in the order the Dashboard shows them (REQ-045a). */
export const WORKFLOW_STEPS: readonly WorkflowStep[] = [
  "classify_tier",
  "prd",
  "design",
  "adr",
  "plan",
  "review_plan",
  "convert_to_beads",
  "polish_beads",
  "implement",
  "review_batches",
  "build_and_tests",
  "close_with_evidence",
];

/**
 * Steps each tier is allowed to omit, from REQ-036 as amended by delta
 * 20260917-workflow-skills §4.1: Medium and Large polish their beads again,
 * and only Small skips the polish pass.
 *
 * `Medium` may skip only `review_plan`, because it writes a plan only when the
 * work needs one. It may not skip a document step: REQ-036(c) lets it leave
 * out the documents that are "not affected", and which those are is not
 * observable from outside, so claiming one was skipped would be a guess.
 */
export const SKIPPABLE_BY_TIER: Readonly<Record<Tier, readonly WorkflowStep[]>> = {
  Small: ["prd", "design", "adr", "plan", "review_plan", "polish_beads"],
  Medium: ["review_plan"],
  Large: [],
};

const DOC_PREFIX: Partial<Record<WorkflowStep, string>> = {
  prd: "docs/product/",
  design: "docs/design/",
  adr: "docs/adr/",
  plan: "docs/plans/",
};

/**
 * A build or test runner, anchored to the START of a command segment.
 *
 * Anchoring matters: the WP-214 acceptance run showed a Worker *searching* for
 * test tooling with `grep -iE 'makefile|pyproject|pytest|...'`, and an
 * unanchored pattern read that as having run the tests.
 */
const TEST_RUNNER = /^(?:(?:npm|npx|yarn|pnpm)\s+(?:run\s+)?(?:test|lint|typecheck|build)|vitest|pytest|tox|nox|cargo\s+test|go\s+test|make\s+(?:test|check|build)|python3?\s+-m\s+(?:pytest|unittest|py_compile))\b/i;

function ranBuildOrTests(line: string): boolean {
  return commandSegments(line).some((segment) => TEST_RUNNER.test(segment));
}

/**
 * Shell evidence whose `br <verb>` command acted on a bead (or, for `create`,
 * acted at all). `shell.ts` holds the rules: a `--help` page is not the step.
 */
function brEvidence(evidence: readonly Evidence[], verb: BrVerb): Evidence[] {
  return evidence.filter(
    (entry) =>
      entry.kind === "shell" &&
      brActions(entry.detail).some((action) => action.verb === verb && (verb === "create" || action.ids.length > 0)),
  );
}

/** A `buildAndTests` value that says nothing was run. */
function saysNothingRan(value: string): boolean {
  return /^\s*(not\s+run|none|n\/?a|skipped|no\b)/i.test(value);
}

/**
 * True when a `finished` report explicitly reported an empty list for a field.
 *
 * An exact negative from the Worker outranks any inferred positive from the
 * timeline: if the Worker finished and said it created no beads, a `br create`
 * in the log was something else (a help page, a failed attempt, a dry run).
 */
function finishedWithEmpty(
  trace: ReconstructedTrace,
  field: "beadsCreated" | "beadsClosed" | "beadsUpdated",
): boolean {
  const finished = trace.reports.filter((report) => report.phase === "finished");
  return finished.length > 0 && finished.every((report) => report[field].length === 0);
}

function reportEvidence(agentId: string, at: string, detail: string): Evidence {
  return { kind: "report", detail, agentId, at };
}

/**
 * A written file as a workspace-relative path, or null when it is not in the
 * workspace (delta 20260917 §5.5). The collector keeps paths as the tool
 * reported them — usually absolute — so `docs/…` never matched and document
 * writes counted as implementation. A `~` path, an absolute path outside the
 * workspace, and any absolute path when the workspace directory is unknown
 * are not evidence.
 */
export function workspacePath(path: string, workspaceDir: string | null | undefined): string | null {
  if (path.startsWith("~")) return null;
  if (!isAbsolute(path)) {
    // `src/../docs/x.md` is a document; `../outside/a.js` is not in the workspace.
    const normal = posix.normalize(path.split("\\").join("/"));
    return normal === ".." || normal.startsWith("../") ? null : normal.replace(/^\.\//, "");
  }
  if (workspaceDir === null || workspaceDir === undefined || workspaceDir === "") return null;
  const inside = relative(resolve(workspaceDir), resolve(path));
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
  return inside.split("\\").join("/");
}

/** Every `shell` and `file` evidence entry of a trace, in order. */
function timelineEvidence(trace: ReconstructedTrace): Evidence[] {
  return trace.records.flatMap((record: TraceRecord) => record.evidence);
}

/** Reports whose `skillsUsed` names `skill` (delta 20260917 §4.9): exact evidence. */
function reportedSkill(trace: ReconstructedTrace, skill: string): Evidence[] {
  return trace.reports
    .filter((report) => (report.skillsUsed ?? []).includes(skill))
    .map((report) => reportEvidence(report.agentId, report.at, `skillsUsed ${report.skillsUsed.join(", ")}`));
}

/** `skill` evidence of the trace's Worker and Reviewers (the Manager only checks skills). */
function loadedSkill(trace: ReconstructedTrace, skill: string): Evidence[] {
  return trace.records
    .filter((record) => record.role !== "manager")
    .flatMap((record) => record.evidence)
    .filter((entry) => entry.kind === "skill" && entry.detail === skill);
}

/**
 * The latest `finished` report that lists skills but not `skill`, as a note,
 * or null. Only meaningful for steps the skill itself defines.
 *
 * A `skillsUsed` the parser could not fully read proves nothing about what is
 * missing from it, so such a report never yields a negative (D-5; review
 * bm-wp-220-nvk.1, B2).
 */
function finishedWithoutSkill(trace: ReconstructedTrace, skill: string): string | null {
  // A finished report whose list could not be read at all still counts as the
  // latest word: an older, readable report must not answer for it (re-review
  // of bm-wp-220-nvk.1).
  const unreadable = (report: ParsedReport) => (report.incompleteFields ?? []).includes("skillsUsed");
  const finished = [...trace.reports]
    .sort(byAt)
    .filter((report) => report.phase === "finished" && ((report.skillsUsed ?? []).length > 0 || unreadable(report)));
  const latest = finished.at(-1);
  if (latest === undefined || unreadable(latest) || latest.skillsUsed.includes(skill)) return null;
  return `the Worker's finished report lists skillsUsed ${latest.skillsUsed.join(", ")} without ${skill}`;
}

interface StepFinding {
  evidence: Evidence[];
  confidence: Confidence;
  /** Set when the step is known NOT to have happened; see `absent()`. */
  absent?: string;
}

/**
 * Exactly known NOT to have happened. An exact negative beats any inference:
 * the same rule the bead counts already follow (a `finished` report saying
 * `beadsCreated: none` is not overridden by a `br` command).
 */
function absent(note: string): StepFinding {
  return { evidence: [], confidence: "exact", absent: note };
}

function exact(evidence: Evidence[]): StepFinding {
  return { evidence, confidence: "exact" };
}

function inferred(evidence: Evidence[]): StepFinding {
  return { evidence, confidence: "inferred" };
}

const NOTHING: StepFinding = { evidence: [], confidence: "unknown" };

/** Evidence for one step: reports first (exact), then the timeline (inferred). */
function findStep(step: WorkflowStep, trace: ReconstructedTrace, context: InferContext): StepFinding {
  const evidence = timelineEvidence(trace);
  const prefix = DOC_PREFIX[step];
  const inWorkspace = (entry: Evidence): string | null =>
    entry.kind === "file" ? workspacePath(entry.detail, context.workspaceDir) : null;

  if (prefix !== undefined) {
    const reported = trace.reports.flatMap((report) =>
      report.filesChanged
        .filter((path) => path.startsWith(prefix))
        .map((path) => reportEvidence(report.agentId, report.at, `filesChanged ${path}`)),
    );
    if (reported.length > 0) return exact(reported);
    const written = evidence.filter((entry) => inWorkspace(entry)?.startsWith(prefix) === true);
    return written.length > 0 ? inferred(written) : NOTHING;
  }

  switch (step) {
    case "classify_tier": {
      const reported = trace.reports.filter((report) => report.tier !== null);
      return reported.length > 0
        ? exact([reportEvidence(reported[0]!.agentId, reported[0]!.at, `tier ${reported[0]!.tier}`)])
        : NOTHING;
    }
    case "review_plan": {
      const reported = reportedSkill(trace, "reviewing-plan");
      if (reported.length > 0) return exact(reported.slice(0, 1));
      // The Worker's exact negative outranks the inference, as for polish: a
      // Reviewer loads reviewing-plan as review criteria, and that must not
      // hide a Worker that skipped its own pass (review bm-wp-220-nvk.1, B1).
      const missing = finishedWithoutSkill(trace, "reviewing-plan");
      if (missing !== null) return absent(missing);
      const loaded = loadedSkill(trace, "reviewing-plan");
      return loaded.length > 0 ? inferred(loaded) : NOTHING;
    }
    case "convert_to_beads": {
      const reported = trace.reports.filter(
        (report) => report.beadsCreated.length > 0 || report.phase === "beads-done",
      );
      if (reported.length > 0) {
        const first = reported[0]!;
        return exact([
          reportEvidence(
            first.agentId,
            first.at,
            first.beadsCreated.length > 0 ? `beadsCreated ${first.beadsCreated.join(", ")}` : "phase beads-done",
          ),
        ]);
      }
      const converted = reportedSkill(trace, "converting-plan-to-beads");
      if (converted.length > 0) return exact(converted.slice(0, 1));
      if (finishedWithEmpty(trace, "beadsCreated")) return NOTHING;
      // A missing converter never means "not converted": a Medium request
      // without a plan creates its beads by hand (delta 20260917 §5.5).
      const loaded = loadedSkill(trace, "converting-plan-to-beads");
      if (loaded.length > 0) return inferred(loaded);
      const created = brEvidence(evidence, "create");
      return created.length > 0 ? inferred(created) : NOTHING;
    }
    case "polish_beads": {
      const reportedPolish = reportedSkill(trace, "polishing-beads");
      if (reportedPolish.length > 0) return exact(reportedPolish.slice(0, 1));
      const polished = trace.reports.filter(
        (report) => report.guardrail !== null && (report.guardrail.polish ?? 0) >= 1,
      );
      if (polished.length > 0) {
        const first = polished[0]!;
        return exact([reportEvidence(first.agentId, first.at, `guardrail ${first.guardrail!.raw}`)]);
      }
      // An older guardrail that SAYS `polish 0` is an exact negative, and it
      // outranks anything the timeline suggests (WP-214 acceptance: a Small
      // request that reported `polish 0/0` was shown as "Beads polished: Done
      // (inferred)"). A guardrail with no polish segment — the format since
      // 2026-09-16 — says nothing about polish (delta 20260917 §5.5).
      const counted = trace.reports.filter((report) => report.guardrail !== null && report.guardrail.polish !== null);
      if (counted.length > 0 && counted.every((report) => report.guardrail!.polish === 0)) {
        const last = counted.at(-1)!;
        return absent(`the Worker reported guardrail ${last.guardrail!.raw}`);
      }
      const missing = finishedWithoutSkill(trace, "polishing-beads");
      if (missing !== null) return absent(missing);
      const loaded = loadedSkill(trace, "polishing-beads");
      if (loaded.length > 0) return inferred(loaded);
      // Otherwise: a polish pass reworks SEVERAL beads in one turn. Repeated
      // `br update` on the SAME bead is ordinary work — F-1 ran three of them
      // on `repo-37g` (description, description again, then status).
      for (const record of trace.records) {
        const updates = brEvidence(record.evidence, "update");
        const distinctBeads = new Set(
          updates.flatMap((entry) =>
            brActions(entry.detail).flatMap((action) => (action.verb === "update" ? action.ids : [])),
          ),
        );
        if (distinctBeads.size >= 2) return inferred(updates);
      }
      return NOTHING;
    }
    case "implement": {
      const reported = trace.reports.filter((report) => report.phase === "bead-implemented");
      if (reported.length > 0) {
        const first = reported[0]!;
        return exact([reportEvidence(first.agentId, first.at, "phase bead-implemented")]);
      }
      // A missing implementing-beads never means "not implemented" (the Small
      // fast path works without it), so there is no negative here.
      const implementedWith = reportedSkill(trace, "implementing-beads");
      if (implementedWith.length > 0) return exact(implementedWith.slice(0, 1));
      const code = evidence.filter((entry) => {
        const path = inWorkspace(entry);
        return path !== null && !path.startsWith("docs/") && !path.startsWith(".beads/");
      });
      return code.length > 0 ? inferred(code) : NOTHING;
    }
    case "review_batches": {
      if (trace.reviews.length > 0 && trace.reviewerIds.length > 0) {
        const review = trace.reviews[0]!;
        return exact([
          { kind: "agent", detail: `BM-REVIEW verdict=${review.verdict ?? "unknown"}`, agentId: review.agentId, at: review.at },
        ]);
      }
      if (trace.reviewerIds.length > 0) {
        return inferred([
          { kind: "agent", detail: `${trace.reviewerIds.length} Reviewer agent(s) exist`, agentId: trace.reviewerIds[0]!, at: null },
        ]);
      }
      return NOTHING;
    }
    case "build_and_tests": {
      const reported = trace.reports.filter(
        (report) => report.buildAndTests !== null && !saysNothingRan(report.buildAndTests),
      );
      if (reported.length > 0) {
        const first = reported[0]!;
        return exact([reportEvidence(first.agentId, first.at, `buildAndTests ${first.buildAndTests}`)]);
      }
      const ran = evidence.filter((entry) => entry.kind === "shell" && ranBuildOrTests(entry.detail));
      return ran.length > 0 ? inferred(ran) : NOTHING;
    }
    case "close_with_evidence": {
      const reported = trace.reports.filter((report) => report.beadsClosed.length > 0);
      if (reported.length > 0) {
        const first = reported[0]!;
        const confirmed = first.beadsClosed.filter((id) => context.beadStatus?.(id) === "closed");
        return exact([
          reportEvidence(
            first.agentId,
            first.at,
            confirmed.length > 0
              ? `beadsClosed ${confirmed.join(", ")} (confirmed closed in the store)`
              : `beadsClosed ${first.beadsClosed.join(", ")}`,
          ),
        ]);
      }
      if (finishedWithEmpty(trace, "beadsClosed")) return NOTHING;
      const closed = brEvidence(evidence, "close");
      return closed.length > 0 ? inferred(closed) : NOTHING;
    }
    default:
      return NOTHING;
  }
}

export interface InferContext {
  /** Current status of a bead id, from the WP-208 lookup. Optional. */
  beadStatus?: (id: string) => string | null;
  /** The workspace's directory, to read absolute file evidence (delta 20260917 §5.5). */
  workspaceDir?: string | null;
}

/**
 * Builds the full table. Always returns all twelve rows, so a step with no
 * evidence is visibly `unknown` rather than missing.
 */
export function inferWorkflowSteps(
  trace: ReconstructedTrace,
  context: InferContext = {},
): WorkflowStepResult[] {
  const tier = trace.tier;
  const skippable = tier === null ? [] : SKIPPABLE_BY_TIER[tier];

  return WORKFLOW_STEPS.map((step) => {
    const found = findStep(step, trace, context);
    if (found.absent !== undefined) {
      return {
        step,
        status: "skipped" as const,
        confidence: "exact" as const,
        evidence: [],
        note: found.absent,
      };
    }
    if (found.evidence.length > 0) {
      return { step, status: "done" as const, confidence: found.confidence, evidence: found.evidence, note: null };
    }
    if (tier !== null && skippable.includes(step)) {
      return {
        step,
        status: "skipped" as const,
        confidence: "exact" as const,
        evidence: [],
        note: `tier ${tier} may omit this step (REQ-036)`,
      };
    }
    return {
      step,
      status: "unknown" as const,
      confidence: "unknown" as const,
      evidence: [],
      note: tier === null ? "no tier was reported, so nothing can be called skipped" : null,
    };
  });
}
