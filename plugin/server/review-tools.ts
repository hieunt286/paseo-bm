/**
 * The enforced review cap (design §16.6, §16.8, §16.9; ADR-027 decisions 2
 * and 10, ship point C; delivery line design §5.3, §5.4): a bound Worker
 * creates its Reviewers and asks for its re-reviews through the plugin's
 * tools, which refuse a review call past the request's cap unless the owner
 * granted more.
 *
 * | Tool | Does |
 * |---|---|
 * | `bm_create_reviewer` | checks the milestone and its stages (delivery line design §5.1) and the cap, snapshots the tree, records the call (`kind: create`, its `tree`) in the request registry, creates `bm-reviewer/<model>` for one new batch with its `BM-BRIEF reviewer … call: <callId>` prompt, and stores the batch, its milestone and its brief |
 * | `bm_rereview` | checks the convergence rule (delivery line design §5.2) and the cap, snapshots the tree, records the call (`kind: rereview`, its `tree`) and creates a **new** Reviewer for the batch the same way, its brief the previous blocking findings and the diff since the batch's previous call (§17.2); the earlier Reviewer is left idle |
 *
 * - **One counter.** The count that enforces is the count the Dashboard shows:
 *   `requestReviewCountOf` (`request-trace.ts`) reads the `reviewCalls` of the
 *   request's trace as `workspaceTracesOf` rebuilds it — `reviewCallsOf` over
 *   the activity stream and the registry's call records together
 *   (`traces.ts`) — or, before the request has a trace, `reviewCallsOf` over
 *   its Reviewers' records. The registry holds call records, never a total.
 * - **The cap** (delivery line design §5.3) is `reviewCapOf`:
 *   `review.callsPerBatch` × min(M, Mmax[tier]) for the tier of the request's
 *   newest report record (the registry's `tier`, which `bm_report` writes),
 *   M its milestone batches — the one being opened included. The ceiling is
 *   the cap plus every `{ calls: n }` grant (`ruleReviewGrantOf`: the same
 *   `overReviewCap` the Orchestrator's rule, the stall reason, the Manager's
 *   notice and the governor use). An `{ untilClean: b }` grant an older build
 *   stored is read, never written, and exempts no call (§5.6).
 * - **Past the cap** (§5.4) the tool opens the request's one `review-cap`
 *   decision, `q:<requestId>:Qn`, `ownerOnly`, through the materialiser's
 *   open path, and refuses naming it; a later hit opens nothing. Only the
 *   owner's answer grants (`applyReviewCapAnswer`).
 * - **Convergence** (delivery line design §5.2): a re-review asks no one. It
 *   goes while the batch's latest result is not a pass, the batch has had
 *   fewer than `review.maxRereviews` re-reviews, and — from the second on —
 *   its latest blocking count is strictly lower than the one before it. The
 *   results are the batch's own (`batches[].results`, which `bm_review`, the
 *   unbound final-answer path and the missing-verdict check append); a batch
 *   an older build opened reads them from the trace's `reviews[]`.
 * - **Snapshots** (delivery line design §17.2, ADR-036): every call records
 *   the Worker's folder as a git tree object (`checkpoint.ts`
 *   `snapshotTree`: a temporary index, objects only). A re-review's brief
 *   holds `git diff` of the batch's previous call's tree and its own, inline
 *   up to `REREVIEW_DIFF_MAX_CHARS`; without both (no git, a git failure, an
 *   older call) it falls back to the Worker's `since` and `fixed`. While no
 *   review of the batch has a verdict (no-verdicts only), the new Reviewer
 *   gets the batch's own brief instead.
 * - **Records before acts.** A call is recorded before the tool creates; a
 *   failed creation removes it. The tools of one request run one at a time
 *   (`serialised`), so two calls never pass one check.
 * - **The retired `review-budget` question** (§5.6) grants nothing any more:
 *   no policy, Main or precedent answers it, and the upgrade sweep withdraws
 *   the open ones (`review-budget-sweep.ts`).
 * - **The plugin's own Reviewers** (`createPluginReviewer`) are named in
 *   their batch's `reviewerIds` before the creation counts as done, so the
 *   off-tool check (`off-tool-reviewer.ts`), which waits for creations under
 *   way, never flags one — the replacement Reviewer of §16.9
 *   (`fallback-reviewer.ts`) included; one whose creation a reload or Paseo's
 *   late error cut short is named at `agent.created` (`creation-settle.ts`).
 * - **A creation call with no Reviewer** (`reviewerId` empty): Paseo threw
 *   after the hook kept the token (`creationMayExist`), or a reload cut the
 *   creation. The call is kept, so `agent.created` can name its Reviewer;
 *   one still empty after `PENDING_TTL_MS` (a binding's pending time) is
 *   cleared by the next `bm_create_reviewer` or `bm_rereview` of its batch
 *   (`clearStaleCreateCalls`), which then starts from a free batch. A
 *   re-review's call is kept and cleared the same way.
 *
 * Common rules (§16.6): a refusal is one line per reason and creates, stores or
 * sends nothing; a pending binding is refused by the shared guard; the request
 * and the Worker come from the binding, never from the input. Nothing here
 * throws into the endpoint.
 */
import { join } from "node:path";
import { NO_BINDER, PENDING_TTL_MS, createBound, creationMayExist, withoutTokenPaths, type AgentBinder, type ToolCaller } from "./agent-bindings";
import { aliasBases } from "./alias-bases";
import { readCoordinationSettings } from "./coordination-rpc";
import { folderOfAgent } from "./create-worker";
import { resolveDataHome, TRACES_DIR_NAME } from "./data-home";
import { highestQuestionOf, openQuestions, type OpenContext, type OpenableQuestion } from "./decision-materialiser";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import type { ServerToolAnswer, ServerTools } from "./decision-tools";
import { snapshotTree } from "./checkpoint";
import { redactText } from "./collector";
import { AGENT_TOOLS_OFF_TOOL_MESSAGE, agentToolsOff } from "./manager";
import type { NoticeQueue } from "./notice-queue";
import { createOutbox, newRecordId, type OutboxDeps, type OutboxRecord } from "./outbox";
import type { DashboardPaseo } from "./paseo-directory";
import { placementBlockOf, placementEntryOf } from "./placements";
import { GIT_READ_ONLY_PREFIX, runGit, type GitRunner } from "./repo-tool";
import { createRequestRegistry, isEmptyCreateCall, newestCallOf, NO_VERDICT_RESULT, type RegisteredRequest, type ReviewBatch, type ReviewCall, type ReviewResult } from "./request-registry";
import { cutText } from "./request-render";
import { requestReviewCountOf } from "./request-trace";
import { reasonOf } from "./role-choices";
import { creationProjectOf, modeFactsOf } from "./role-instructions";
import { profileOf } from "./role-mode";
import { actingTools, answered, boundAs, fixThese, refused, withoutNulls, type BoundCaller } from "./tool-kit";
import { CREATE_REVIEWER_FACE, REREVIEW_FACE, createReviewerRules, reviewMilestoneOf, schemaIssues, type CreateReviewerInput, type ReviewMilestone } from "../shared/bm-tools";
import { FINDING_BLOCKING } from "../shared/bm-report";
import type { ParsedReview, Tier } from "../shared/contracts";
import { decisionKindOf, questionDecisionId, type Decision } from "../shared/decisions";
import { overReviewCap, reviewCapOf } from "../shared/orchestrator-rules";
import { REVIEW_CAP_SUBJECT } from "../shared/question-subjects";
import { plural } from "../shared/text";
import type { RuleReviewGrant } from "../shared/rule-input";
import { reviewerBriefLineOf } from "../shared/notices";
import { timeOrZero } from "../shared/time";
import { PLUGIN_VERSION } from "../shared/version";

export const CREATE_REVIEWER_TOOL = "bm_create_reviewer";
export const REREVIEW_TOOL = "bm_rereview";
/** The profile and alias a plugin-created Reviewer is made from. */
export const REVIEWER_PROFILE_ID = "bm-reviewer";
/** Title of every Reviewer the plugin creates for a batch. */
export const REVIEWER_TITLE = "Beads Reviewer";

/** The caller is not a bound Worker. */
export const REVIEW_NOT_BOUND_MESSAGE =
  "bm_create_reviewer and bm_rereview are only for a Worker paseo-bm created with its own tools, and you are not one: work with Reviewers as your instructions say. Nothing was created or sent.";
/** No Paseo handle has reached the plugin yet. */
export const NO_PASEO_REVIEW_MESSAGE = "paseo-bm has no connection to Paseo yet; try again in a moment. Nothing was created or sent.";
/** The request has no report record yet: its tier, and so its budget, is unknown. */
export const NO_REPORT_YET_MESSAGE = "paseo-bm has no report of your request yet: send your received report first (bm_report, phase received). Nothing was created.";
/** The `bm-reviewer` profile is missing (or Paseo's configuration cannot be read). */
export const NO_REVIEWER_PROFILE_MESSAGE =
  'There is no "bm-reviewer" profile on this machine, so no Reviewer can be created; tell the owner to open Beads Manager → Settings. Nothing was created.';

/** The longest diff a re-review's brief holds inline (delivery line design §17.2). */
export const REREVIEW_DIFF_MAX_CHARS = 40_000;
/** The longest `git diff --stat` it holds. */
const REREVIEW_STAT_MAX_CHARS = 8_000;
const REREVIEW_DIFF_SHOWN = "40,000";

/** The fixes between two snapshots of a batch (§17.2): the two trees, the changed files and the diff (null: longer than the bound). */
export interface FixDiff {
  from: string;
  to: string;
  stat: string;
  diff: string | null;
}

/**
 * `git diff --stat` and `git diff` of two snapshot trees in `cwd`
 * (§17.2), read-only (`GIT_READ_ONLY_PREFIX`, no external diff or textconv),
 * redacted; the diff null when it is longer than `REREVIEW_DIFF_MAX_CHARS`.
 * Null when git fails. Never throws.
 */
export async function fixDiffOf(cwd: string, from: string, to: string, git: GitRunner = runGit): Promise<FixDiff | null> {
  const run = async (args: readonly string[]): Promise<string> =>
    redactText((await git([...GIT_READ_ONLY_PREFIX, "diff", "--no-ext-diff", "--no-textconv", ...args, from, to, "--"], { cwd, maxBytes: 1024 * 1024 })).stdout);
  try {
    const stat = cutText(await run(["--stat=200"]), REREVIEW_STAT_MAX_CHARS);
    const diff = await run([]).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return null;
      throw error;
    });
    return { from, to, stat, diff: diff === null || diff.length > REREVIEW_DIFF_MAX_CHARS ? null : diff };
  } catch {
    return null;
  }
}

/** The blocking findings of a review's text, verbatim (§17.2): each `- severity: blocking` item with its indented lines. Pure. */
export function blockingFindingsOf(text: string): string[] {
  const items: string[][] = [];
  let open = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (FINDING_BLOCKING.test(line)) {
      items.push([line]);
      open = true;
    } else if (open && /^\s+\S/.test(line) && !/^\s*(?:>\s*)*[-*]\s/.test(line)) items.at(-1)!.push(line);
    else open = false;
  }
  return items.map((item) => item.join("\n"));
}

/**
 * The previous result's blocking findings, verbatim (§17.2): read from the
 * review record of the batch's newest result with a verdict (a no-verdict is
 * passed over) — its blocking items, or the whole review when it lists none
 * that way; a line saying so when that record is no longer stored. Pure.
 */
export function previousFindingsOf(results: readonly ReviewResult[], records: readonly Pick<OutboxRecord, "id" | "kind" | "text">[]): string {
  const result = results.findLast((entry) => entry.verdict !== NO_VERDICT_RESULT);
  if (result === undefined) return "(no review of this batch has a verdict yet)";
  const record = records.find((entry) => entry.id === result.recordId && entry.kind === "review");
  if (record === undefined) return `(the review ${result.recordId || "of this batch"} is no longer stored: the Worker's account below names the findings)`;
  const items = blockingFindingsOf(record.text);
  return items.length > 0 ? items.join("\n") : record.text.trim();
}

/**
 * The brief of a re-review's new Reviewer (delivery line design §17.2): the
 * previous blocking findings verbatim, then the files changed since the
 * batch's previous call and their diff (inline up to the bound, else the
 * command that shows it), and the Worker's `fixed`; without a diff, the
 * Worker's `since` and `fixed`. Pure.
 */
export function rereviewBriefOf(input: { requestId: string; batchId: string; findings: string; fixed: string; fixes: FixDiff | null; since?: string | null }): string {
  const { requestId, batchId, fixes } = input;
  const fixed = input.fixed.replace(/\r\n/g, "\n").trim();
  const command = fixes === null ? "" : `git diff ${fixes.from} ${fixes.to}`;
  const lines =
    fixes !== null
      ? [
          "Fixes — files changed since the last review:",
          fixes.stat.trimEnd() || "(no file changed since the last review)",
          `The diff (up to ${REREVIEW_DIFF_SHOWN} characters; else: ${command}):`,
          fixes.diff === null ? `(longer than ${REREVIEW_DIFF_SHOWN} characters: run ${command} in your folder)` : fixes.diff.trimEnd() || "(empty)",
          `Checks the Worker ran for these files: ${fixed}`,
        ]
      : [
          "Fixes — paseo-bm has no snapshot of the last review to compare, so the Worker's account stands for the diff:",
          input.since === undefined || input.since === null ? "The diff: the Worker named no commit; read the files the findings and the fixes name." : `The diff: git diff ${input.since}`,
          `How the Worker fixed them, and the checks it ran: ${fixed}`,
        ];
  return [
    `Re-review batch ${batchId} of request ${requestId}: a fresh Reviewer checks only the fixes.`,
    "Previous blocking findings (verbatim):",
    input.findings,
    ...lines,
    `requestId: ${requestId}`,
    `batchId: ${batchId}`,
  ].join("\n");
}

/** The snapshot of `cwd` for a review call (§17.2); undefined without git or on a git failure. Never throws. */
async function snapshotOf(cwd: string): Promise<string | undefined> {
  try {
    return await snapshotTree(cwd);
  } catch {
    return undefined;
  }
}

/**
 * The brief of a batch (design §16.6): what the Reviewer reviews — the stages,
 * the scope and the checks the Worker ran — never the criteria, which are its
 * role's. Stored with the batch, so a replacement Reviewer gets it again
 * (§16.9). Pure.
 */
export function reviewerBriefOf(input: {
  requestId: string;
  batchId: string;
  stages: readonly string[];
  scope: string;
  checks?: string | null;
  /** Delivery line design §5.1, §5.5: the milestone, and the commit its diff starts from. */
  milestone?: ReviewMilestone | null;
  since?: string | null;
}): string {
  const block = (text: string): string => text.replace(/\r\n/g, "\n").trim();
  return [
    `Review batch ${input.batchId} of request ${input.requestId}.`,
    ...(input.milestone === undefined || input.milestone === null ? [] : [`milestone: ${input.milestone}`]),
    `stages: ${input.stages.join(", ")}`,
    ...(input.since === undefined || input.since === null ? [] : [`since: ${input.since}`]),
    "scope:",
    block(input.scope),
    ...(input.checks === undefined || input.checks === null || input.checks.trim() === "" ? [] : ["checks run:", block(input.checks)]),
    `requestId: ${input.requestId}`,
    `batchId: ${input.batchId}`,
  ].join("\n");
}

/** A Reviewer's first prompt: its `BM-BRIEF reviewer … call:` line, then the batch's brief (§16.6, §16.9). */
export function reviewerPromptOf(requestId: string, batchId: string, callId: string, brief: string): string {
  return `${reviewerBriefLineOf(requestId, batchId, callId)}\n${brief}`;
}

// ---------------------------------------------------------------------------
// The plugin's own Reviewers (design §16.8: never off-tool).
// ---------------------------------------------------------------------------

/** Creations under way, by the Worker they are for. */
const inFlight = new Map<string, Set<Promise<unknown>>>();

/**
 * Waits for every Reviewer creation under way for Worker `parentId`: Paseo's
 * `agent.created` can arrive before `agents.create` returns the id. Never
 * rejects.
 */
export async function pluginCreationsSettled(parentId: string): Promise<void> {
  const pending = inFlight.get(parentId);
  if (pending === undefined) return;
  await Promise.allSettled([...pending]);
}

/** The SDK slice a plugin-created Reviewer needs; `PaseoApi` is structurally assignable. */
export interface ReviewerCreationPaseo {
  agents: {
    create(options: {
      config: Record<string, unknown>;
      cwd: string;
      parent?: string;
      title: string;
      labels: Record<string, string>;
      prompt: string;
    }): Promise<{ id: string }>;
  };
  /** A placement's Reviewer is created in the placement (delivery line design §3.3). */
  workspaces?: {
    ref(workspaceId: string): {
      agents: { create(options: { config: Record<string, unknown>; parent?: string; title: string; labels: Record<string, string>; prompt: string }): Promise<{ id: string }> };
    };
  };
}

/** What `createPluginReviewer` creates. */
export interface PluginReviewerSpec {
  workspaceId: string;
  requestId: string;
  /** The Worker: the Reviewer's `parent`, and the binding's. */
  workerId: string;
  batchId: string;
  /** The create call it answers (`bm_create_reviewer`), which the registry then names it on; none for a replacement (§16.9). */
  callId?: string | null;
  cwd: string;
  /** Its first prompt, starting with its `BM-BRIEF reviewer … call:` line. */
  prompt: string;
  /** The alias: `bm-reviewer`, or a fallback alias `bm-reviewer-fallback-<n>`. */
  alias: string;
  model: string | null;
  /** The alias's base provider; no token outside `TOOL_PROVIDERS` (the binder's rule). */
  base: string | null;
  /** The Reviewer mode (§7.2); none when undefined or null. */
  modeId?: string | null;
  thinkingOptionId?: string | null;
  /** Labels beside `bm.role`, `bm.requestId`, `bm.batchId` and `bm.version` (`bm.replaces`). */
  labels?: Record<string, string>;
  title?: string;
}

/**
 * Creates one Reviewer for a batch of a bound Worker (design §16.6, §16.9):
 * `parent` = the Worker, the labels, and a binding of role reviewer for the
 * same request and batch, so its `bm_review` delivers. The `agent.create` hook still runs, so it gets its
 * instructions. The registry names it in its batch (`noteReviewer`, on
 * `spec.callId` when given) before the creation counts as done, so the
 * off-tool check, which waits for it, knows it as the plugin's own. Throws
 * what Paseo threw, after the binding was discarded.
 */
export async function createPluginReviewer(
  paseo: ReviewerCreationPaseo,
  spec: PluginReviewerSpec,
  deps: { home: string; binder?: AgentBinder; log?: (message: string) => void },
): Promise<{ reviewerId: string }> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  // Marked under way BEFORE Paseo is asked: its agent.created may come before agents.create returns.
  let done!: () => void;
  const marker = new Promise<void>((resolve) => {
    done = resolve;
  });
  const pending = inFlight.get(spec.workerId) ?? new Set<Promise<unknown>>();
  pending.add(marker);
  inFlight.set(spec.workerId, pending);
  try {
    const created = await createBound(
      deps.binder ?? NO_BINDER,
      { role: "reviewer", base: spec.base, workspaceId: spec.workspaceId, requestId: spec.requestId, parentId: spec.workerId, batchId: spec.batchId },
      (mcpServers) => {
        const options = {
          config: {
            provider: spec.model === null ? spec.alias : `${spec.alias}/${spec.model}`,
            ...(spec.modeId !== undefined && spec.modeId !== null ? { modeId: spec.modeId } : {}),
            ...(spec.thinkingOptionId !== undefined && spec.thinkingOptionId !== null ? { thinkingOptionId: spec.thinkingOptionId } : {}),
            ...(mcpServers !== undefined ? { mcpServers } : {}),
          },
          parent: spec.workerId,
          title: spec.title ?? `${REVIEWER_TITLE} ${spec.batchId}`,
          labels: { "bm.role": "reviewer", "bm.requestId": spec.requestId, "bm.batchId": spec.batchId, "bm.version": PLUGIN_VERSION, ...spec.labels },
          prompt: spec.prompt,
        };
        // Delivery line design §3.3: the Reviewer of a placement's request is created in that placement.
        if (paseo.workspaces !== undefined && placementEntryOf(deps.home, spec.workspaceId) !== null) return paseo.workspaces.ref(spec.workspaceId).agents.create(options);
        return paseo.agents.create({ ...options, cwd: spec.cwd });
      },
      log,
    );
    try {
      createRequestRegistry(deps.home, { log }).noteReviewer(spec.workspaceId, spec.requestId, spec.batchId, created.id, spec.callId ?? null);
    } catch (error) {
      log(`[paseo-bm] could not add Reviewer ${created.id} to batch ${spec.batchId} of ${spec.requestId}: ${reasonOf(error)}`);
    }
    return { reviewerId: created.id };
  } finally {
    done();
    pending.delete(marker);
    if (pending.size === 0) inFlight.delete(spec.workerId);
  }
}

// ---------------------------------------------------------------------------
// The cap (delivery line design §5.3, §5.4).
// ---------------------------------------------------------------------------

/** True for a `pass` verdict. */
export function isPassVerdict(verdict: string | null | undefined): boolean {
  return typeof verdict === "string" && /^\s*pass\b/i.test(verdict);
}

/** Where a request stands against its review cap (delivery line design §5.3). */
export interface ReviewCapState {
  tier: Tier;
  /** The owner's `review.callsPerBatch` and `review.maxRereviews`, read once per call. */
  callsPerBatch: number;
  maxRereviews: number;
  /** Σ of the request's `{ calls: n }` grants. */
  granted: number;
  /** The one count, now (`requestReviewCountOf`). */
  calls: number;
  /** The reviews of the request's trace: the results of a batch an older build opened (delivery line design §5.2). */
  traceReviews: readonly ParsedReview[];
}

/** The ceiling at `milestones` batches: the cap (`reviewCapOf`) plus the granted calls. */
export function reviewCeilingAt(state: Pick<ReviewCapState, "tier" | "callsPerBatch" | "granted">, milestones: number): number {
  return reviewCapOf(state.tier, milestones, state) + state.granted;
}

/** The sum of a request's `{ calls: n }` grants. */
export function grantedCallsOf(request: Pick<RegisteredRequest, "reviews">): number {
  return request.reviews.grants.reduce((sum, grant) => sum + (grant.calls ?? 0), 0);
}

/** A request's milestone batches: every batch it opened (delivery line design §5.3). */
export function milestoneBatchesOf(request: Pick<RegisteredRequest, "reviews">): number {
  return request.reviews.batches.length;
}

/** The deps the cap reads with: the data folder and a Paseo handle (the agent list). */
interface CapDeps {
  home: string;
  paseo: unknown;
  log: (message: string) => void;
}

/**
 * The request's cap state now, or null when its tier is not known (no report
 * record yet). Rejects when the trace store cannot be read.
 */
export async function reviewCapStateOf(deps: CapDeps, request: RegisteredRequest): Promise<ReviewCapState | null> {
  if (request.tier === null) return null;
  const { calls, trace } = await requestReviewCountOf(
    { location: { tracesDir: join(deps.home, TRACES_DIR_NAME) }, paseo: deps.paseo as DashboardPaseo, home: deps.home },
    request.workspaceId,
    request.requestId,
  );
  const { callsPerBatch, maxRereviews } = readCoordinationSettings({ home: deps.home, log: deps.log }).review;
  return {
    tier: request.tier,
    callsPerBatch,
    maxRereviews,
    granted: grantedCallsOf(request),
    calls,
    traceReviews: trace?.reviews ?? [],
  };
}

/**
 * The request's grants and milestone batches as every cap check reads them
 * (delivery line design §5.3): the Orchestrator's `review.over-budget` rule
 * (`RuleInput.reviewGrant`), the stall reason, the Manager's notice
 * (`overrunOf`) and, through `reviewCapStateOf`, the tools — the sum of its
 * `{ calls: n }` grants and its batches. Pure.
 */
export function ruleReviewGrantOf(request: Pick<RegisteredRequest, "reviews">): Required<RuleReviewGrant> {
  return { calls: grantedCallsOf(request), milestones: milestoneBatchesOf(request) };
}

/**
 * True when one more review call would pass the ceiling at `milestones`
 * batches (§5.3): the count after it passes the cap plus the granted calls.
 */
export function overCapAfterOne(state: ReviewCapState, milestones: number): boolean {
  return overReviewCap(state.calls + 1, reviewCeilingAt(state, milestones));
}

/**
 * The first refusal at the cap (delivery line design §5.4), word for word:
 * the count and the ceiling, the tier and the milestone batches, and the
 * question paseo-bm asked the owner.
 */
export function reviewCapRefusalOf(input: { requestId: string; calls: number; cap: number; tier: Tier; milestones: number; qn: string }): string {
  return (
    `Review cap reached for ${input.requestId}: ${input.calls} of ${input.cap} calls (${input.tier}, ${plural(input.milestones, "milestone batch", "milestone batches")}). ` +
    `paseo-bm asked the owner as ${input.qn}. Send \`blocked\` with \`waitingOn: [${questionDecisionId(input.requestId, input.qn)}]\`. Nothing was created or sent.`
  );
}

/** A second cap hit (delivery line design §5.4): once per request, so nothing opens. */
export function reviewCapSpentOf(qn: string): string {
  return `The request's review cap is spent and the owner answered ${qn}; send \`finished\` with the open blocking findings. Nothing was created or sent.`;
}

/**
 * The one owner decision of a request past its cap (delivery line design
 * §5.4): subject `review-cap`, class `cost`, `ownerOnly`. Option a grants
 * `callsPerBatch` more calls; b, finishing with the open blocking findings
 * listed, is recommended when the last batch stopped converging, a otherwise.
 * Pure.
 */
export function reviewCapQuestionOf(input: {
  qn: string;
  requestId: string;
  calls: number;
  cap: number;
  tier: Tier;
  milestones: number;
  callsPerBatch: number;
  stoppedConverging: boolean;
}): OpenableQuestion {
  return {
    id: input.qn,
    text:
      `Request ${input.requestId} reached its review cap: ${input.calls} of ${input.cap} calls (${input.tier}, ` +
      `${plural(input.milestones, "milestone batch", "milestone batches")}). How should it go on?`,
    subject: REVIEW_CAP_SUBJECT,
    class: "cost",
    ownerOnly: true,
    options: [
      { key: "a", text: `Allow one more round of batches (+${input.callsPerBatch} calls)`, recommended: !input.stoppedConverging, effects: ["cost"], grant: { calls: input.callsPerBatch } },
      { key: "b", text: "Finish as it stands, open blocking findings listed", recommended: input.stoppedConverging, effects: ["none"] },
      { key: "c", text: "Stop this request", recommended: false, effects: ["none"] },
    ],
  };
}

/** The request's `review-cap` decision, the newest when an older build left more than one; null when none. Throws when the store cannot be read. */
export function reviewCapDecisionOf(store: Pick<DecisionStore, "list">, workspaceId: string, requestId: string): Decision | null {
  const asked = store
    .list({ workspaceId, requestId })
    .filter((decision) => decision.subject === REVIEW_CAP_SUBJECT && decisionKindOf(decision.id) === "question");
  return asked.sort((a, b) => questionNumberOf(a.id) - questionNumberOf(b.id)).at(-1) ?? null;
}

/** The number of `q:<requestId>:Q<n>`; 0 when it has none. */
function questionNumberOf(id: string): number {
  return Number(id.slice(id.lastIndexOf(":Q") + 2)) || 0;
}

/** True when the request's newest batch stopped converging (§5.2): the rule refuses its re-review for its counts. */
export function lastBatchStoppedConverging(batches: readonly ReviewBatch[], traceReviews: readonly ParsedReview[], maxRereviews: number): boolean {
  const last = batches.at(-1);
  if (last === undefined) return false;
  const refusal = convergenceRefusalOf({ batchId: last.batchId, results: batchResultsOf(last, traceReviews), calls: last.calls, maxRereviews });
  return refusal !== null && refusal.endsWith(CONVERGENCE_STOP_TAIL);
}

// ---------------------------------------------------------------------------
// Convergence (delivery line design §5.2).
// ---------------------------------------------------------------------------

/**
 * A batch's results, oldest first (§5.2): its own, or — for a batch an older
 * build opened, which has none — the reviews of the request's trace that name
 * it. Pure.
 */
export function batchResultsOf(batch: Pick<ReviewBatch, "batchId" | "results">, traceReviews: readonly ParsedReview[]): ReviewResult[] {
  if (batch.results !== undefined) return batch.results;
  return traceReviews
    .filter((review) => review.batchId === batch.batchId && review.verdict !== null)
    .map((review) => ({ at: review.at, recordId: review.recordId ?? "", verdict: review.verdict!, blocking: review.blockingCount }))
    .sort((a, b) => timeOrZero(a.at) - timeOrZero(b.at));
}

/** What a stopped batch is told after why (§5.2): no question is asked. */
export const CONVERGENCE_STOP_TAIL =
  "Fix what you can and open the next milestone batch, or send `finished` with the open blocking findings in `reviewFindingsOpen`. Nothing was sent.";

/**
 * The refusal of one more re-review of a batch, or null when it may go
 * (§5.2), checked in this order:
 * 1. a result answers the batch's newest call (else: wait for it);
 * 2. that result is not a `pass`;
 * 3. the batch has had fewer than `maxRereviews` re-reviews;
 * 4. from the second re-review on, the latest blocking count is strictly lower
 *    than the one before it; an unknown count (`null`) never counts as lower.
 * The request's cap (§5.3) is the caller's. Pure.
 */
export function convergenceRefusalOf(input: {
  batchId: string;
  results: readonly ReviewResult[];
  /** The batch's calls: its create and its re-reviews. */
  calls: ReviewBatch["calls"];
  maxRereviews: number;
}): string | null {
  const { batchId, results, calls, maxRereviews } = input;
  const latest = results.at(-1);
  const newestCall = newestCallOf({ calls });
  if (latest === undefined || (newestCall !== undefined && timeOrZero(latest.at) < timeOrZero(newestCall.at))) {
    return `Batch ${batchId} has no verdict on its last review yet: wait for it to reach you. Nothing was sent.`;
  }
  if (isPassVerdict(latest.verdict)) return `Batch ${batchId} passed: nothing to re-review. Nothing was sent.`;
  const rereviews = calls.filter((call) => call.kind === "rereview").length;
  if (rereviews >= maxRereviews) return `Batch ${batchId} had its ${maxRereviews} re-review${maxRereviews === 1 ? "" : "s"}. ${CONVERGENCE_STOP_TAIL}`;
  if (rereviews >= 1) {
    const before = results.at(-2)?.blocking ?? null;
    const now = latest.blocking;
    if (before === null || now === null || now >= before) {
      const shown = (count: number | null): string => (count === null ? "unknown" : String(count));
      return `Batch ${batchId} stopped converging (blocking ${shown(before)} → ${shown(now)}). ${CONVERGENCE_STOP_TAIL}`;
    }
  }
  return null;
}

/**
 * The refusal of a new batch for its milestone, or null (§5.1): a `plan`
 * batch below Large, or after a plan batch of the request passed. Pure.
 */
export function milestoneRefusalOf(
  milestone: ReviewMilestone,
  tier: Tier,
  batches: ReadonlyArray<Pick<ReviewBatch, "batchId" | "milestone" | "results">>,
  traceReviews: readonly ParsedReview[],
): string | null {
  if (milestone !== "plan") return null;
  if (tier !== "Large") return "Only a Large request reviews its plan; nothing was created.";
  const passed = batches.find((batch) => batch.milestone === "plan" && batchResultsOf(batch, traceReviews).some((result) => isPassVerdict(result.verdict)));
  if (passed !== undefined) return `Plan batch ${passed.batchId} passed, and a request reviews its plan once: open a wave or finished batch instead. Nothing was created.`;
  return null;
}

/**
 * The refusal of a named milestone its stages contradict, or null (§5.1): a
 * `plan` batch reviews `plan` or `beads` (and `documents`), never
 * `implementation`; a `wave` or `finished` batch reviews `implementation`,
 * never `plan` or `beads`. A milestone left out is derived from the stages,
 * so it never contradicts them. Pure.
 */
export function stagesRefusalOf(input: Pick<CreateReviewerInput, "stages" | "milestone">): string | null {
  const { milestone, stages } = input;
  if (milestone === undefined) return null;
  const has = (stage: string): boolean => (stages as readonly string[]).includes(stage);
  const fits = milestone === "plan" ? (has("plan") || has("beads")) && !has("implementation") : has("implementation") && !has("plan") && !has("beads");
  if (fits) return null;
  const reviews = milestone === "plan" ? "plan or beads, never implementation" : "implementation, never plan or beads";
  return `A ${milestone} batch reviews ${reviews}: the stages ${stages.join(", ")} do not fit it; nothing was created.`;
}

/**
 * Clears the request's creating calls whose Reviewer never appeared within
 * `PENDING_TTL_MS` of the call (design §16.8): a batch with no Reviewer and
 * only such a call is free again, and a re-review's (§17.2) may be asked
 * again. Returns the request as it stands after. Throws when the registry
 * cannot be written.
 */
export function clearStaleCreateCalls(home: string, request: RegisteredRequest, now: Date, log: (message: string) => void): RegisteredRequest {
  const stale = request.reviews.batches.flatMap((batch) =>
    batch.calls.filter(
      (call) => isEmptyCreateCall(call) && (call.kind === "rereview" || batch.reviewerIds.length === 0) && now.getTime() - (Date.parse(call.at) || 0) > PENDING_TTL_MS,
    ),
  );
  if (stale.length === 0) return request;
  const registry = createRequestRegistry(home, { log });
  for (const call of stale) {
    registry.removeReviewCall(request.workspaceId, request.requestId, call.callId);
    log(`[paseo-bm] the review call ${call.callId} of ${request.requestId} created no Reviewer in time; ${call.kind === "create" ? "its batch is free again" : "it was not counted"}.`);
  }
  return registry.get(request.workspaceId, request.requestId) ?? request;
}

/** The answer to a call on a batch whose Reviewer is still being created (an empty create call, within its time). */
function stillCreatingOf(batchId: string, nothing: string): ServerToolAnswer {
  return refused(`The Reviewer of batch ${batchId} is still being created; try again in a moment, or open a new batch. ${nothing}`);
}

/** Runs the review tools of one request one at a time: a check and its record never interleave with another call's. */
const queues = new Map<string, Promise<unknown>>();
function serialised<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve();
  const run = before.then(work, work);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

// ---------------------------------------------------------------------------
// The grant (delivery line design §5.4).
// ---------------------------------------------------------------------------

/**
 * Appends the grant of every `review-cap` decision of `decisions` the owner
 * answered to its request (delivery line design §5.4): option a's
 * `{ calls }`, as `{ decisionId, calls, untilCleanBatch: null }`. Nobody but
 * the owner answers one (`ownerOnly`); should an answer by anyone else ever
 * be stored, it grants nothing. Options b and c grant nothing: their answer
 * reaches the Worker as any answer does. Once per decision. The settlement
 * hook calls it for every answer. Returns
 * the decisions whose grant was added. Never throws: a failure is one log line.
 */
export function applyReviewCapAnswer(
  decisions: readonly Decision[],
  deps: { home?: string | null; log?: (message: string) => void } = {},
): string[] {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const added: string[] = [];
  const owners = decisions.filter(
    (decision) => decision.subject === REVIEW_CAP_SUBJECT && decision.status === "answered" && decision.requestId !== null && decision.answer?.by === "owner",
  );
  if (owners.length === 0) return added;
  let home: string | null;
  try {
    home = deps.home !== undefined ? deps.home : resolveDataHome().home;
  } catch {
    home = null;
  }
  if (home === null) return added;
  for (const decision of owners) {
    const key = decision.answer!.optionKey;
    const grant = key === null ? undefined : decision.options.find((option) => option.key === key)?.grant;
    if (grant === undefined || !("calls" in grant)) continue;
    try {
      const outcome = createRequestRegistry(home, { log }).addGrant(decision.workspaceId, decision.requestId!, { decisionId: decision.id, calls: grant.calls, untilCleanBatch: null });
      if (outcome === "added") added.push(decision.id);
      else if (outcome === "no-request") log(`[paseo-bm] the review-cap answer of ${decision.id} names request ${decision.requestId}, which the registry does not hold; nothing was granted.`);
    } catch (error) {
      log(`[paseo-bm] could not record the review-cap grant of ${decision.id}: ${reasonOf(error)}`);
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// The tools.
// ---------------------------------------------------------------------------

export interface ReviewToolDeps {
  /** The binder of the endpoint (read when a call comes); none (unbound Reviewers) when absent. */
  binder?: () => AgentBinder;
  /** The last Paseo handle a hook or RPC brought; null before any did. */
  paseo: () => unknown;
  /** The data folder (the endpoint's: it serves no tools without one). */
  home: () => string;
  log?: (message: string) => void;
  now?: () => Date;
  /** The notice queue a re-review goes through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue">;
  /** The outbox's record ids and masking; tests pin them. */
  outbox?: Pick<OutboxDeps, "newId" | "env">;
  /** The review-cap decision the tools opened (delivery line design §5.4): the event bus's `decision.opened`, as `bm_questions`' are. */
  onOpened?: (opened: readonly Decision[], paseo: unknown) => unknown;
}

type BoundWorker = BoundCaller & { requestId: string };

function boundWorkerOf(caller: ToolCaller | null): BoundWorker | null | "no-request" {
  const worker = boundAs(caller, "worker");
  if (worker === null) return null;
  return worker.requestId === null ? "no-request" : (worker as BoundWorker);
}

/** The `reviewCalls` a tool answers after its call: `<n> of <ceiling>` at `milestones` batches, the call counted (the tools of a request run one at a time). */
function callsAfter(before: ReviewCapState, milestones: number): string {
  return `${before.calls + 1} of ${reviewCeilingAt(before, milestones)}`;
}

/**
 * The bound Worker's `bm_create_reviewer` and `bm_rereview` (design §16.6),
 * as server-run tools the endpoint composes with the Worker's others. Never
 * throws.
 */
export function createReviewTools(deps: ReviewToolDeps): ServerTools {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const paseoOf = (): unknown => {
    const paseo = deps.paseo();
    return paseo === null || paseo === undefined ? null : paseo;
  };
  const registryOf = (home: string) => createRequestRegistry(home, { log });

  /** The request and where it stands against its cap, or the refusal. */
  const standing = async (
    home: string,
    paseo: unknown,
    worker: BoundWorker,
    nothing: string,
  ): Promise<{ request: RegisteredRequest; state: ReviewCapState } | ServerToolAnswer> => {
    const request = registryOf(home).get(worker.workspaceId, worker.requestId);
    if (request === null) return refused(`paseo-bm knows no request ${worker.requestId} in this workspace, so it cannot count its review calls; tell the owner in one line. ${nothing}`);
    let state: ReviewCapState | null;
    try {
      state = await reviewCapStateOf({ home, paseo, log }, request);
    } catch (error) {
      return refused(`paseo-bm could not count the review calls of ${request.requestId} (${reasonOf(error)}); try again in a moment. ${nothing}`);
    }
    if (state === null) return refused(NO_REPORT_YET_MESSAGE);
    return { request, state };
  };

  /**
   * One more call past the cap at `milestones` batches (delivery line design
   * §5.4): the request's one `review-cap` decision, opened the first time
   * through the materialiser's open path, then the refusal. A decision still
   * unsettled is named again; a settled one refuses with the spent text. Either
   * way nothing else opens, and nothing is created or sent.
   */
  const capReached = async (
    home: string,
    paseo: unknown,
    worker: BoundWorker,
    request: RegisteredRequest,
    state: ReviewCapState,
    milestones: number,
  ): Promise<ServerToolAnswer> => {
    const facts = { requestId: request.requestId, calls: state.calls, cap: reviewCeilingAt(state, milestones), tier: state.tier, milestones };
    const nothing = "Nothing was created or sent.";
    let store: DecisionStore;
    let asked: Decision | null;
    try {
      store = createDecisionStore(home, { log });
      asked = reviewCapDecisionOf(store, worker.workspaceId, request.requestId);
    } catch (error) {
      return refused(`paseo-bm could not read its decisions (${reasonOf(error)}); try again in a moment. ${nothing}`);
    }
    if (asked !== null) {
      const qn = asked.id.slice(asked.id.lastIndexOf(":") + 1);
      return refused(asked.status === "open" || asked.status === "needs-confirmation" ? reviewCapRefusalOf({ ...facts, qn }) : reviewCapSpentOf(qn));
    }
    // Numbered after the request's highest Qn and opened at once, as bm_questions does: nothing reads the store in between.
    const qn = `Q${highestQuestionOf(store, worker.workspaceId, request.requestId) + 1}`;
    const at = now().toISOString();
    const context: OpenContext = { home, store, workspaceId: worker.workspaceId, now: at, log, outcome: { opened: [], superseded: [], answered: [], reversed: [] } };
    const stoppedConverging = lastBatchStoppedConverging(request.reviews.batches, state.traceReviews, state.maxRereviews);
    openQuestions(context, {
      requestId: request.requestId,
      questions: [reviewCapQuestionOf({ ...facts, qn, callsPerBatch: state.callsPerBatch, stoppedConverging })],
      askedBy: worker.agentId,
      askedAt: at,
      byPlugin: true,
    });
    if (store.get(questionDecisionId(request.requestId, qn), worker.workspaceId) === null) {
      return refused(`paseo-bm could not ask the owner about the review cap of ${request.requestId}; see its log. Tell the owner in one line. ${nothing}`);
    }
    if (context.outcome.opened.length > 0 && deps.onOpened !== undefined) {
      try {
        await deps.onOpened(context.outcome.opened, paseo);
      } catch (error) {
        log(`[paseo-bm] the review-cap question ${questionDecisionId(request.requestId, qn)} opened, but its events failed: ${reasonOf(error)}`);
      }
    }
    return refused(reviewCapRefusalOf({ ...facts, qn }));
  };

  // -------------------------------------------------------------------------
  // bm_create_reviewer.
  // -------------------------------------------------------------------------

  const create = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const worker = boundWorkerOf(caller);
    if (worker === null) return refused(REVIEW_NOT_BOUND_MESSAGE);
    if (worker === "no-request") return refused("paseo-bm does not know your request, so it cannot create a Reviewer for it; tell the owner in one line and stop. Nothing was created.");
    const input = withoutNulls(raw);
    const shape = schemaIssues(CREATE_REVIEWER_FACE.inputSchema, input);
    if (shape.length > 0) return fixThese(CREATE_REVIEWER_TOOL, shape);
    const typed = input as CreateReviewerInput;
    const broken = createReviewerRules(typed);
    if (broken.length > 0) return fixThese(CREATE_REVIEWER_TOOL, broken);
    // Delivery line design §5.1: a named milestone its stages contradict.
    const contradicted = stagesRefusalOf(typed);
    if (contradicted !== null) return refused(contradicted);
    const home = deps.home();
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_REVIEW_MESSAGE);
    // A Reviewer gets Paseo's tools only when it is created, and a Worker without them could not cancel it (§16.6).
    if (await agentToolsOff(paseo)) return refused(AGENT_TOOLS_OFF_TOOL_MESSAGE);
    const nothing = "Nothing was created.";
    // Delivery line design §3.6: a retired, archived or failed placement takes no new agent.
    const blocked = placementBlockOf(home, worker.workspaceId);
    if (blocked !== null) return refused(`${blocked[0]!.toUpperCase()}${blocked.slice(1)}. ${nothing}`);

    return serialised(`${worker.workspaceId}:${worker.requestId}`, async () => {
      const found = await standing(home, paseo, worker, nothing);
      if ("ok" in found) return found;
      const { state } = found;
      let request: RegisteredRequest;
      try {
        request = clearStaleCreateCalls(home, found.request, now(), log);
      } catch (error) {
        return refused(`paseo-bm could not write its request registry (${reasonOf(error)}); nothing was created. Tell the owner in one line.`);
      }
      const batch = request.reviews.batches.find((entry) => entry.batchId === typed.batchId);
      if (batch !== undefined && batch.reviewerIds.length === 0 && batch.calls.some(isEmptyCreateCall)) return stillCreatingOf(typed.batchId, nothing);
      if (batch !== undefined && (batch.reviewerIds.length > 0 || batch.calls.some((call) => call.kind === "create"))) {
        return refused(`Batch ${typed.batchId} already has a Reviewer: use bm_rereview for its re-review, or open a new batch. ${nothing}`);
      }
      const milestone = reviewMilestoneOf(typed);
      const misplaced = milestoneRefusalOf(milestone, state.tier, request.reviews.batches, state.traceReviews);
      if (misplaced !== null) return refused(misplaced);
      // Delivery line design §5.3: M counts the batch being opened.
      const milestones = milestoneBatchesOf(request) + (batch === undefined ? 1 : 0);
      if (overCapAfterOne(state, milestones)) return capReached(home, paseo, worker, request, state, milestones);
      const profile = await profileOf(paseo, REVIEWER_PROFILE_ID, log);
      if (profile === null) return refused(NO_REVIEWER_PROFILE_MESSAGE);
      // The Worker's own folder, read from Paseo — never a folder the agent typed.
      const cwd = await folderOfAgent(paseo, worker.agentId, worker.workspaceId);
      if (cwd === null) return refused(`paseo-bm could not read your folder from Paseo; try again in a moment. ${nothing}`);

      // The tree as the Reviewer finds it (§17.2), then the call, recorded under the registry's write before anything is created.
      const tree = await snapshotOf(cwd);
      // A call id in the outbox's shape (`out-<12 hex>`, design §16.4).
      const callId = (deps.outbox?.newId ?? newRecordId)();
      const brief = reviewerBriefOf({
        requestId: request.requestId,
        batchId: typed.batchId,
        milestone,
        stages: typed.stages,
        scope: typed.scope,
        checks: typed.checks ?? null,
        since: typed.since ?? null,
      });
      try {
        const recorded = registryOf(home).addReviewCall(worker.workspaceId, request.requestId, typed.batchId, callOf(callId, tree), brief, milestone);
        if (recorded === "batch-taken") return refused(`Batch ${typed.batchId} already has a Reviewer: use bm_rereview for its re-review, or open a new batch. ${nothing}`);
        if (recorded !== "added") return refused(`paseo-bm knows no request ${request.requestId} in this workspace; tell the owner in one line. ${nothing}`);
      } catch (error) {
        return refused(`paseo-bm could not write its request registry (${reasonOf(error)}); nothing was created. Tell the owner in one line.`);
      }
      const made = await createFor(CREATE_REVIEWER_TOOL, home, paseo, worker, { requestId: request.requestId, batchId: typed.batchId, callId, cwd, brief, model: profile.model }, `batch ${typed.batchId} is free again`);
      if ("ok" in made) return made;
      return answered({ reviewerId: made.reviewerId, batchId: typed.batchId, reviewCalls: callsAfter(state, milestones) });
    });
  };

  /** A call of the review tools, before its Reviewer is named: its snapshot when there is one (§17.2). */
  const callOf = (callId: string, tree: string | undefined, kind: ReviewCall["kind"] = "create"): ReviewCall => ({
    callId,
    kind,
    reviewerId: "",
    at: now().toISOString(),
    ...(tree === undefined ? {} : { tree }),
  });

  /**
   * Creates the Reviewer of a recorded call (`bm_create_reviewer`'s, and
   * since ADR-036 `bm_rereview`'s): the Reviewer rules a Worker's Runtime
   * facts name, then `createPluginReviewer`. A creation Paseo refused removes
   * its call; Paseo's error after the hook kept the token keeps it, so its
   * `agent.created` names its Reviewer (creation-settle.ts), else it is
   * cleared after `PENDING_TTL_MS`. The Reviewer, or the refusal.
   */
  const createFor = async (
    tool: string,
    home: string,
    paseo: unknown,
    worker: BoundWorker,
    call: { requestId: string; batchId: string; callId: string; cwd: string; brief: string; model: string | null },
    retry: string,
  ): Promise<{ reviewerId: string } | ServerToolAnswer> => {
    const { requestId, batchId, callId, cwd } = call;
    try {
      // The Reviewer rules, as a Worker's Runtime facts name them (§7.2): the action boundary of the project included.
      const project = await creationProjectOf(cwd, { workspaceId: worker.workspaceId }, log);
      const facts = await modeFactsOf("worker", paseo, cwd, log, project.boundary);
      const modeId = facts.reviewerModeNone === true ? null : (facts.reviewerModeId ?? null);
      const base = (await aliasBases(paseo))[REVIEWER_PROFILE_ID] ?? null;
      return await createPluginReviewer(
        paseo as ReviewerCreationPaseo,
        {
          workspaceId: worker.workspaceId,
          requestId,
          workerId: worker.agentId,
          batchId,
          cwd,
          prompt: reviewerPromptOf(requestId, batchId, callId, call.brief),
          alias: REVIEWER_PROFILE_ID,
          model: call.model,
          base,
          modeId,
          callId,
        },
        { home, binder: deps.binder?.(), log },
      );
    } catch (error) {
      // Paseo's refusal, verbatim but for a token path (design §16.5: a token never reaches an agent or a log).
      const reason = withoutTokenPaths(reasonOf(error));
      if (creationMayExist(error)) {
        const named = registryOf(home)
          .get(worker.workspaceId, requestId)
          ?.reviews.batches.find((entry) => entry.batchId === batchId)
          ?.calls.find((entry) => entry.callId === callId && entry.reviewerId !== "");
        if (named !== undefined) return { reviewerId: named.reviewerId };
        log(`[paseo-bm] ${tool}: Paseo answered the Reviewer of batch ${batchId} for Worker ${worker.agentId} with an error after it may have created it: ${reason}`);
        return refused(
          `Paseo answered with an error after it may have created the Reviewer: ${reason}. If the Reviewer appears, its review reaches you as usual; if not, ${retry} in ${PENDING_TTL_MS / 60_000} minutes, or open a new batch.`,
        );
      }
      // A failed creation removes its call: it never happened.
      try {
        registryOf(home).removeReviewCall(worker.workspaceId, requestId, callId);
      } catch (removal) {
        log(`[paseo-bm] could not remove the failed review call ${callId} of ${requestId}: ${reasonOf(removal)}`);
      }
      log(`[paseo-bm] ${tool} could not create the Reviewer of batch ${batchId} for Worker ${worker.agentId}: ${reason}`);
      return refused(`Paseo refused to create the Reviewer: ${reason}. Nothing was created.`);
    }
  };

  // -------------------------------------------------------------------------
  // bm_rereview (delivery line design §5.2, §17.2).
  // -------------------------------------------------------------------------

  /** The review records a batch's results name: the Worker's workspace's outbox, and the request's when it moved. Never throws. */
  const reviewRecordsOf = (home: string, workspaceIds: readonly string[]): OutboxRecord[] =>
    [...new Set(workspaceIds)].flatMap((workspaceId) => {
      try {
        return createOutbox(home).list(workspaceId);
      } catch {
        return [];
      }
    });

  const rereview = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const worker = boundWorkerOf(caller);
    if (worker === null) return refused(REVIEW_NOT_BOUND_MESSAGE);
    if (worker === "no-request") return refused("paseo-bm does not know your request, so it cannot send a re-review; tell the owner in one line and stop. Nothing was sent.");
    const input = withoutNulls(raw);
    const shape = schemaIssues(REREVIEW_FACE.inputSchema, input);
    if (shape.length > 0) return fixThese(REREVIEW_TOOL, shape);
    const { batchId, fixed, since } = input as { batchId: string; fixed: string; since?: string };
    const home = deps.home();
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_REVIEW_MESSAGE);
    // A re-review creates a new Reviewer (§17.2), so bm_create_reviewer's checks hold.
    if (await agentToolsOff(paseo)) return refused(AGENT_TOOLS_OFF_TOOL_MESSAGE);
    const nothing = "Nothing was sent.";
    const blocked = placementBlockOf(home, worker.workspaceId);
    if (blocked !== null) return refused(`${blocked[0]!.toUpperCase()}${blocked.slice(1)}. ${nothing}`);

    return serialised(`${worker.workspaceId}:${worker.requestId}`, async () => {
      const stored = registryOf(home).get(worker.workspaceId, worker.requestId);
      let known: RegisteredRequest | null;
      try {
        known = stored === null ? null : clearStaleCreateCalls(home, stored, now(), log);
      } catch (error) {
        return refused(`paseo-bm could not write its request registry (${reasonOf(error)}); nothing was sent. Tell the owner in one line.`);
      }
      const batch = known?.reviews.batches.find((entry) => entry.batchId === batchId);
      if (known === null || batch === undefined) return refused(`paseo-bm knows no batch ${batchId} of ${worker.requestId}: open it with bm_create_reviewer. ${nothing}`);
      if (batch.reviewerIds.length === 0 && batch.calls.some(isEmptyCreateCall)) return stillCreatingOf(batchId, nothing);
      if (batch.reviewerIds.length === 0) return refused(`Batch ${batchId} has no Reviewer yet: create it with bm_create_reviewer. ${nothing}`);
      const found = await standing(home, paseo, worker, nothing);
      if ("ok" in found) return found;
      const { request, state } = found;
      // Delivery line design §5.2: the convergence rule, asking no one; then the request's cap (§5.3, §5.4).
      const results = batchResultsOf(batch, state.traceReviews);
      const stop = convergenceRefusalOf({ batchId, results, calls: batch.calls, maxRereviews: state.maxRereviews });
      if (stop !== null) return refused(stop);
      const milestones = milestoneBatchesOf(request);
      if (overCapAfterOne(state, milestones)) return capReached(home, paseo, worker, request, state, milestones);
      const profile = await profileOf(paseo, REVIEWER_PROFILE_ID, log);
      if (profile === null) return refused(NO_REVIEWER_PROFILE_MESSAGE);
      const cwd = await folderOfAgent(paseo, worker.agentId, worker.workspaceId);
      if (cwd === null) return refused(`paseo-bm could not read your folder from Paseo; try again in a moment. ${nothing}`);

      // §17.2: the fixes are the diff between the batch's previous call's tree and this one's.
      const tree = await snapshotOf(cwd);
      const previous = newestCallOf(batch)?.tree;
      // No review of the batch has a verdict yet (each ended without one): the new Reviewer does the batch's review itself.
      const reviewed = results.some((result) => result.verdict !== NO_VERDICT_RESULT);
      const fixes = !reviewed || tree === undefined || previous === undefined ? null : await fixDiffOf(cwd, previous, tree);
      const brief = !reviewed
        ? batch.brief
        : rereviewBriefOf({
            requestId: request.requestId,
            batchId,
            findings: previousFindingsOf(results, reviewRecordsOf(home, [worker.workspaceId, request.workspaceId])),
            fixed,
            fixes,
            since: since ?? null,
          });
      const callId = (deps.outbox?.newId ?? newRecordId)();
      try {
        const recorded = registryOf(home).addReviewCall(worker.workspaceId, request.requestId, batchId, callOf(callId, tree, "rereview"));
        if (recorded !== "added") throw new Error(`the registry answered ${recorded}`);
      } catch (error) {
        return refused(`paseo-bm could not record the review call (${reasonOf(error)}); nothing was sent. Tell the owner in one line.`);
      }
      const made = await createFor(REREVIEW_TOOL, home, paseo, worker, { requestId: request.requestId, batchId, callId, cwd, brief, model: profile.model }, `ask for the re-review of batch ${batchId} again`);
      if ("ok" in made) return made;
      return answered({ reviewerId: made.reviewerId, reviewCalls: callsAfter(state, milestones) });
    });
  };

  return actingTools([CREATE_REVIEWER_FACE, REREVIEW_FACE], { [CREATE_REVIEWER_TOOL]: create, [REREVIEW_TOOL]: rereview }, "Nothing was created or sent");
}
