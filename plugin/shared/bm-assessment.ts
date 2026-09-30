import { z } from "zod";
import type { JsonSchema } from "./bm-tools";

/**
 * The Orchestrator's assessment of one request (Orchestrator design §5.3,
 * REQ-075): the input of the `bm_assessment` tool, the JSON after a
 * hand-written `BM-ASSESSMENT` line, and the `result` of a `done` line in the
 * assessment store are all this one shape.
 *
 * Two checks of the same rules live here, side by side:
 * - `ASSESSMENT_INPUT_SCHEMA` plus `rubricIssues` — what the model sees and
 *   what the `bm_assessment` tool checks (`shared/bm-tools.ts`, which builds no
 *   tool schema from Zod);
 * - `assessmentResultSchema` — the Zod schema the assessment reader and the
 *   client parse with.
 * A test holds them to the same answer on the same inputs, so the reader
 * never refuses what the tool accepted.
 *
 * This module is `shared/`, so it stays free of Node and React Native imports.
 */

/** The six criteria, in the order of `roles/orchestrator.md`'s rubric. */
export const ASSESSMENT_CRITERIA = ["sizing", "process-weight", "coordination", "user-communication", "report-quality", "review-quality"] as const;
export type AssessmentCriterion = (typeof ASSESSMENT_CRITERIA)[number];
export const FINDING_SEVERITIES = ["info", "warning", "problem"] as const;
/** The roles a suggestion may be appended to: never the Orchestrator itself. */
export const SUGGESTION_ROLES = ["manager", "worker", "reviewer"] as const;
export const ASSESSMENT_SCORES = [1, 2, 3, 4, 5, null] as const;
export const MAX_FINDINGS = 12;
export const MAX_SUGGESTIONS = 5;
export const MAX_SUGGESTION_CHARS = 600;
/** The line that starts a hand-written assessment, and the text the tool returns. */
export const ASSESSMENT_BLOCK = "BM-ASSESSMENT";

// ---------------------------------------------------------------------------
// What the tool checks: a JSON Schema, and the one rule it cannot say.
// ---------------------------------------------------------------------------

const TEXT: JsonSchema = { type: "string", minLength: 1 };
const EMPTY = "Leave it out or [] when there are none; never the word none.";

export const ASSESSMENT_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rubric"],
  properties: {
    rubric: {
      type: "array",
      minItems: ASSESSMENT_CRITERIA.length,
      maxItems: ASSESSMENT_CRITERIA.length,
      description: "Exactly one entry per criterion.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "score", "note"],
        properties: {
          criterion: { type: "string", enum: ASSESSMENT_CRITERIA },
          score: {
            type: ["integer", "null"],
            enum: ASSESSMENT_SCORES,
            description: "5 = exactly as the role instructions expect, 3 = deviates but does not harm the outcome, 1 = clearly breaks or slows the request; null = not enough data.",
          },
          note: { ...TEXT, description: "Why, in one or two sentences, pointing at the part of the trace it rests on." },
        },
      },
    },
    findings: {
      type: "array",
      maxItems: MAX_FINDINGS,
      description: EMPTY,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "text", "evidence"],
        properties: {
          severity: { type: "string", enum: FINDING_SEVERITIES },
          text: { ...TEXT, description: "What happened." },
          evidence: { ...TEXT, description: "The part of the trace that shows it, quoted or named." },
        },
      },
    },
    suggestions: {
      type: "array",
      maxItems: MAX_SUGGESTIONS,
      description: `A paragraph the user may append to one role's instructions. ${EMPTY}`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "text", "why"],
        properties: {
          role: { type: "string", enum: SUGGESTION_ROLES },
          text: { ...TEXT, maxLength: MAX_SUGGESTION_CHARS, description: "An instruction to that agent that holds for every future request." },
          why: { ...TEXT, description: "The finding it answers." },
        },
      },
    },
  },
};

/**
 * Each criterion exactly once: what the schema's six items cannot say. Reads
 * only well-formed entries, so it adds nothing to a shape the schema refused.
 */
export function rubricIssues(input: unknown): string[] {
  const rubric = (input as { rubric?: unknown } | null | undefined)?.rubric;
  if (!Array.isArray(rubric)) return [];
  const named = rubric.map((entry) => (entry as { criterion?: unknown } | null)?.criterion).filter((name): name is string => typeof name === "string");
  const missing = ASSESSMENT_CRITERIA.filter((criterion) => !named.includes(criterion));
  const repeated = ASSESSMENT_CRITERIA.filter((criterion) => named.filter((name) => name === criterion).length > 1);
  const out: string[] = [];
  if (missing.length > 0) out.push(`input.rubric: has no entry for ${missing.join(", ")}`);
  if (repeated.length > 0) out.push(`input.rubric: scores ${repeated.join(", ")} more than once; one entry per criterion`);
  return out;
}

// ---------------------------------------------------------------------------
// What the reader and the client parse with.
// ---------------------------------------------------------------------------

const text = z.string().refine((value) => value.trim().length > 0, "must not be empty");

export const assessmentRubricEntrySchema = z.strictObject({
  criterion: z.enum(ASSESSMENT_CRITERIA),
  score: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.null()]),
  note: text,
});
export type AssessmentRubricEntry = z.infer<typeof assessmentRubricEntrySchema>;

export const assessmentFindingSchema = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES),
  text,
  evidence: text,
});
export type AssessmentFinding = z.infer<typeof assessmentFindingSchema>;

export const assessmentSuggestionSchema = z.strictObject({
  role: z.enum(SUGGESTION_ROLES),
  text: text.refine((value) => value.length <= MAX_SUGGESTION_CHARS, `must be at most ${MAX_SUGGESTION_CHARS} characters`),
  why: text,
});
export type AssessmentSuggestion = z.infer<typeof assessmentSuggestionSchema>;

/** A left-out `findings` or `suggestions` parses as `[]`; `null` is refused, as the tool refuses it. */
export const assessmentResultSchema = z
  .strictObject({
    rubric: z.array(assessmentRubricEntrySchema).length(ASSESSMENT_CRITERIA.length),
    findings: z.array(assessmentFindingSchema).max(MAX_FINDINGS).default([]),
    suggestions: z.array(assessmentSuggestionSchema).max(MAX_SUGGESTIONS).default([]),
  })
  .superRefine((value, context) => {
    for (const issue of rubricIssues(value)) context.addIssue({ code: "custom", path: ["rubric"], message: issue.replace(/^input\.rubric: /, "") });
  });
export type AssessmentResult = z.infer<typeof assessmentResultSchema>;
