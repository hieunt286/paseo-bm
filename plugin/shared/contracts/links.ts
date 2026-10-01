import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { answerBySchema, decisionStatusSchema } from "../decisions";
import { checksVerdictSchema, claimLabelSchema, confidenceSchema, traceStateSchema } from "./dashboard";
import { agentRoleSchema, tierSchema, workspaceIdSchema } from "./persisted";

/**
 * The links' one RPC, `links.why` (autonomy design §E.2, §E.4; change-011 C7):
 * Work → request → Why? reads the chain behind a request over
 * `server/links.ts`. Import from `shared/contracts.ts`, which re-exports this
 * module.
 */

// ---------------------------------------------------------------------------
// Bounds: the output never grows with the store.
// ---------------------------------------------------------------------------

/** Most chains one lookup returns (a bead or a file can be named by many requests); `more` counts the rest. */
export const LINKS_WHY_MAX_CHAINS = 20;
/** Most items of one link (decisions, beads, changes, commits, review batches, agents, edges); its `more` counts the rest. */
export const LINKS_WHY_MAX_ITEMS = 100;
/** Most entries of a list inside one item (a commit's files, a change's commits, a batch's reviews). */
export const LINKS_WHY_MAX_NESTED = 20;
/** Longest id, bead id or path the input takes. */
export const LINKS_WHY_MAX_INPUT_CHARS = 1_000;

// ---------------------------------------------------------------------------
// The chain, as `server/links.ts` derives it, bounded and without the sources.
// ---------------------------------------------------------------------------

/** `found`; `absent` — never expected, and `reason` says why; `missing` — expected and not found, or not readable. */
export const linkStatusSchema = z.enum(["found", "absent", "missing"]);

const linkOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    status: linkStatusSchema,
    /** Why it is absent or missing; null when found. */
    reason: z.string().nullable(),
    items: z.array(item),
    /** Items not sent (`LINKS_WHY_MAX_ITEMS`). */
    more: z.number().int().nonnegative(),
  });

export const whyDecisionSchema = z.object({
  id: z.string(),
  kind: z.enum(["question", "orchestrator", "fallback", "override", "held"]).nullable(),
  status: decisionStatusSchema,
  askedAt: z.string(),
  /** Masked, one line. */
  question: z.string().nullable(),
  answeredBy: answerBySchema.nullable(),
  answeredAt: z.string().nullable(),
  precedentId: z.string().nullable(),
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
});

export const whyPrecedentSchema = z.object({
  id: z.string(),
  decisionId: z.string(),
  /** False when `precedents.json` no longer holds it. */
  found: z.boolean(),
  reason: z.string().nullable(),
  subject: z.string().nullable(),
  scope: z.string().nullable(),
  /** The standing answer, masked, one line. */
  text: z.string().nullable(),
  createdAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  supersededBy: z.string().nullable(),
});

export const whyBeadSchema = z.object({
  id: z.string(),
  actions: z.array(z.enum(["created", "updated", "closed"])),
  /** `exact` when a report names it, `inferred` when only a `br` command does. */
  confidence: confidenceSchema,
  via: z.array(z.enum(["report", "br"])),
  /** Null when the bead store was not read. */
  inStore: z.boolean().nullable(),
  recordReason: z.string().nullable(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  /** `Split-from:` of its description. */
  splitFrom: z.array(z.string()),
});

export const whyChangeSchema = z.object({
  /** Relative to the workspace folder (absolute outside it, or when the folder is unknown). */
  path: z.string(),
  /** `detected`, `self-reported`, or null when only a commit names it. */
  label: claimLabelSchema.nullable(),
  via: z.array(z.enum(["report", "file-evidence", "commit-bead", "commit-path-time"])),
  commits: z.array(z.string()),
  /** Its only link is a commit by path and time. */
  onlyCommitByTime: z.boolean(),
});

export const whyCommitSchema = z.object({
  hash: z.string(),
  at: z.string(),
  /** Masked subject line. */
  subject: z.string().nullable(),
  files: z.array(z.string()),
  /** Files not sent (`LINKS_WHY_MAX_NESTED`). */
  filesMore: z.number().int().nonnegative(),
  link: z.enum(["bead", "path-and-time"]),
  beads: z.array(z.string()),
});

export const whyChecksSchema = z.object({
  status: linkStatusSchema,
  reason: z.string().nullable(),
  verdict: checksVerdictSchema.nullable(),
  named: z.array(z.object({ check: z.string(), label: claimLabelSchema })),
  /** Finished-unverified (§C.3). */
  unverified: z.boolean(),
  reportAt: z.string().nullable(),
});

export const whyReviewBatchSchema = z.object({
  batchId: z.string().nullable(),
  /** The batch's latest verdict; null when not recorded. */
  verdict: z.string().nullable(),
  /** A null `blockingCount` is unknown, never zero. */
  reviews: z.array(z.object({ agentId: z.string(), at: z.string(), verdict: z.string().nullable(), blockingCount: z.number().int().nullable() })),
});

/** One agent's turns of the request: its role, how many, the first and the last. */
export const whyAgentTurnsSchema = z.object({
  agentId: z.string(),
  role: agentRoleSchema,
  count: z.number().int().nonnegative(),
  first: z.string(),
  last: z.string(),
});

/** A supersession, kept: `from` was replaced (or split, or handed over), `to` replaced it. */
export const whyEdgeSchema = z.object({
  kind: z.enum(["superseded-by", "split-into", "handoff", "replaced-by"]),
  from: z.string(),
  to: z.string(),
});

export const whyChainSchema = z.object({
  workspaceId: workspaceIdSchema,
  request: z.object({
    requestId: z.string(),
    traceId: z.string(),
    requestedAt: z.string(),
    /** The request's first line, masked; null when not recorded. */
    text: z.string().nullable(),
    state: traceStateSchema,
    tier: tierSchema.nullable(),
    linking: confidenceSchema,
    workerIds: z.array(z.string()),
    reviewerIds: z.array(z.string()),
    /** `store-only`: rebuilt without Paseo's agent list. */
    basis: z.enum(["live", "store-only"]),
  }),
  decisions: linkOf(whyDecisionSchema),
  precedents: linkOf(whyPrecedentSchema),
  beads: linkOf(whyBeadSchema),
  changes: linkOf(whyChangeSchema),
  commits: linkOf(whyCommitSchema).extend({
    /** Commits of the span linked to nothing of the request. */
    unlinked: z.number().int().nonnegative(),
    /** The span held more commits than the server reads. */
    truncated: z.boolean(),
  }),
  checks: whyChecksSchema,
  reviews: linkOf(whyReviewBatchSchema),
  turns: linkOf(whyAgentTurnsSchema),
  handoffs: linkOf(whyEdgeSchema),
  edges: z.array(whyEdgeSchema),
  /** Edges not sent (`LINKS_WHY_MAX_ITEMS`). */
  edgesMore: z.number().int().nonnegative(),
  notices: z.array(z.string()),
});

const lookupValue = z.string().trim().min(1).max(LINKS_WHY_MAX_INPUT_CHARS);

/**
 * `links.why` — reads only; nothing is written. Exactly one of `requestId`,
 * `bead`, `file` (relative to the workspace folder, or absolute) or `decision`.
 *
 * - `requestId`: its one chain; an unknown request → `E_TRACE_NOT_FOUND`.
 * - `bead`: the chains of the requests whose reports or `br` commands name it.
 *   None, and the bead store does not hold it → `E_BEAD_NOT_FOUND`; none, but
 *   it is stored (or the store was not read) → empty `chains` with `reason`.
 * - `file`: the chains of the requests whose reports or recorded edits name
 *   it; none → empty `chains` with `reason`.
 * - `decision`: the chain of the request it carries, with the decision in
 *   `decision`; an unknown decision → `E_DECISION_NOT_FOUND`; a project-wide
 *   one (no request) → empty `chains` with `reason`.
 * - No usable data folder, or a store that cannot be read →
 *   `E_DATA_HOME_UNAVAILABLE`.
 *
 * Bounded: at most `LINKS_WHY_MAX_CHAINS` chains (`more` counts the rest),
 * `LINKS_WHY_MAX_ITEMS` items per link, `LINKS_WHY_MAX_NESTED` per inner list.
 */
export const linksWhyRpc = defineRpc({
  name: "links.why",
  input: z
    .object({
      workspaceId: workspaceIdSchema,
      requestId: lookupValue.optional(),
      bead: lookupValue.optional(),
      file: lookupValue.optional(),
      decision: lookupValue.optional(),
    })
    .strict()
    .refine((input) => [input.requestId, input.bead, input.file, input.decision].filter((value) => value !== undefined).length === 1, {
      message: "give exactly one of requestId, bead, file or decision",
    }),
  output: z.object({
    chains: z.array(whyChainSchema),
    /** Chains not sent (`LINKS_WHY_MAX_CHAINS`). */
    more: z.number().int().nonnegative(),
    /** Why no chain holds it; null when one does. */
    reason: z.string().nullable(),
    /** A `decision` lookup: the decision itself. */
    decision: whyDecisionSchema.optional(),
    /** A `bead` lookup: whether the bead store holds it; null when the store was not read. */
    beadInStore: z.boolean().nullable().optional(),
  }),
});

export type LinkStatus = z.infer<typeof linkStatusSchema>;
export type LinksWhyInput = z.infer<typeof linksWhyRpc.input>;
export type LinksWhyOutput = z.infer<typeof linksWhyRpc.output>;
export type WhyChain = z.infer<typeof whyChainSchema>;
export type WhyDecision = z.infer<typeof whyDecisionSchema>;
export type WhyEdge = z.infer<typeof whyEdgeSchema>;
