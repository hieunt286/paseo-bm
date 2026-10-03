/**
 * The enforced review budget (design §16.6, §16.8, §16.9; ADR-027 decisions 2
 * and 10, ship point C): a bound Worker creates its Reviewers and asks for its
 * re-reviews through the plugin's tools, which refuse a review call past the
 * request's budget unless the owner granted more.
 *
 * | Tool | Does |
 * |---|---|
 * | `bm_create_reviewer` | checks the budget, records the call (`kind: create`) in the request registry, creates `bm-reviewer/<model>` for one new batch with its `BM-BRIEF reviewer … call: <callId>` prompt, and stores the batch and its brief |
 * | `bm_rereview` | checks the budget and the batch's one re-review, stores a `message` outbox record, records the call (`kind: rereview`, the record id as `callId`) and delivers `BM-DELIVERY message <recordId>` to the batch's newest live Reviewer |
 *
 * - **One counter.** The count that enforces is the count the Dashboard shows:
 *   `requestReviewCountOf` (`request-trace.ts`) reads the `reviewCalls` of the
 *   request's trace as `workspaceTracesOf` rebuilds it — `reviewCallsOf` over
 *   the activity stream and the registry's call records together
 *   (`traces.ts`) — or, before the request has a trace, `reviewCallsOf` over
 *   its Reviewers' records. The registry holds call records, never a total.
 * - **The budget** is the owner's `review.<tier>Budget` (Settings →
 *   Coordination) for the tier of the request's newest report record (the
 *   registry's `tier`, which `bm_report` writes). The ceiling is that budget
 *   plus every `{ calls: n }` grant. A live `{ untilClean: b }` grant lets
 *   batch b go on past it and lifts its one-re-review limit until b has a
 *   `pass` verdict; its tool calls are counted, but left out of the
 *   comparison while the grant is live (`ruleReviewGrantOf`: the same
 *   `overReviewCeiling` the Orchestrator's rule and the Manager's notice use).
 * - **Records before acts.** A call is recorded before the tool creates or
 *   sends; a failed creation or send removes it. The tools of one request run
 *   one at a time (`serialised`), so two calls never pass one check.
 * - **The grant** (`applyReviewBudgetGrants`): an answered `review-budget`
 *   decision — by the owner, or by the policy where `cost` is delegated —
 *   appends its chosen option's grant to the request; a precedent never
 *   answers one (`precedent-resolve.ts`).
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
 *   (`clearStaleCreateCalls`), which then starts from a free batch.
 *
 * Common rules (§16.6): a refusal is one line per reason and creates, stores or
 * sends nothing; a pending binding is refused by the shared guard; the request
 * and the Worker come from the binding, never from the input. Nothing here
 * throws into the endpoint.
 */
import { join } from "node:path";
import { NO_BINDER, PENDING_TTL_MS, createBound, creationMayExist, withoutTokenPaths, type AgentBinder, type ToolCaller } from "./agent-bindings";
import { aliasBases } from "./alias-bases";
import { parseReviews } from "./bm-report";
import { readReviewBudget } from "./coordination-rpc";
import { folderOfAgent } from "./create-worker";
import { resolveDataHome, TRACES_DIR_NAME } from "./data-home";
import type { ServerToolAnswer, ServerTools } from "./decision-tools";
import { AGENT_TOOLS_OFF_TOOL_MESSAGE, agentToolsOff } from "./manager";
import type { NoticeQueue } from "./notice-queue";
import { createOutbox, deliverRecord, newRecordId, type OutboxDeps, type OutboxRecord } from "./outbox";
import type { DashboardPaseo } from "./paseo-directory";
import { createRequestRegistry, isEmptyCreateCall, type RegisteredRequest, type ReviewBatch } from "./request-registry";
import { requestReviewCountOf } from "./request-trace";
import { asRecord, nonEmpty, reasonOf } from "./role-choices";
import { creationProjectOf, modeFactsOf } from "./role-instructions";
import { profileOf } from "./role-mode";
import { actingTools, answered, boundAs, deliveryOf, fixThese, outboxDepsOf, refused, withoutNulls, type BoundCaller } from "./tool-kit";
import type { ReconstructedTrace } from "./traces";
import { CREATE_REVIEWER_FACE, REREVIEW_FACE, createReviewerRules, schemaIssues, type CreateReviewerInput } from "../shared/bm-tools";
import type { Tier } from "../shared/contracts";
import { REVIEW_BUDGET_SUBJECT, policyMayGrant, type Decision } from "../shared/decisions";
import { overReviewCeiling, reviewCeilingOf } from "../shared/orchestrator-rules";
import type { RuleReviewGrant } from "../shared/rule-input";
import { reviewerBriefLineOf } from "../shared/notices";
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

/** The first line of a re-review delivery (design §16.6), before the Worker's `fixed`. */
export function rereviewLineOf(batchId: string): string {
  return `Re-review batch ${batchId}: check only that the previous blocking findings are fixed and the fixes broke nothing.`;
}

/** The refusal of a review call past the budget (design §16.8), word for word. */
export function budgetRefusalOf(input: { requestId: string; calls: number; budget: number; tier: Tier; batchId: string }): string {
  return [
    `Review budget reached for ${input.requestId}: ${input.calls} of ${input.budget} review calls (${input.tier}).`,
    'Ask the owner with bm_questions: subject "review-budget", class "cost", options that grant more',
    `(grant { calls: n } or { untilClean: "${input.batchId}" }) and one that does not, then report blocked.`,
    "Nothing was created or sent.",
  ].join("\n");
}

/**
 * The brief of a batch (design §16.6): what the Reviewer reviews — the stages,
 * the scope and the checks the Worker ran — never the criteria, which are its
 * role's. Stored with the batch, so a replacement Reviewer gets it again
 * (§16.9). Pure.
 */
export function reviewerBriefOf(input: { requestId: string; batchId: string; stages: readonly string[]; scope: string; checks?: string | null }): string {
  const block = (text: string): string => text.replace(/\r\n/g, "\n").trim();
  return [
    `Review batch ${input.batchId} of request ${input.requestId}.`,
    `stages: ${input.stages.join(", ")}`,
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
      (mcpServers) =>
        paseo.agents.create({
          config: {
            provider: spec.model === null ? spec.alias : `${spec.alias}/${spec.model}`,
            ...(spec.modeId !== undefined && spec.modeId !== null ? { modeId: spec.modeId } : {}),
            ...(spec.thinkingOptionId !== undefined && spec.thinkingOptionId !== null ? { thinkingOptionId: spec.thinkingOptionId } : {}),
            ...(mcpServers !== undefined ? { mcpServers } : {}),
          },
          cwd: spec.cwd,
          parent: spec.workerId,
          title: spec.title ?? `${REVIEWER_TITLE} ${spec.batchId}`,
          labels: { "bm.role": "reviewer", "bm.requestId": spec.requestId, "bm.batchId": spec.batchId, "bm.version": PLUGIN_VERSION, ...spec.labels },
          prompt: spec.prompt,
        }),
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
// The budget (design §16.8).
// ---------------------------------------------------------------------------

/** True for a `pass` verdict. */
export function isPassVerdict(verdict: string | null | undefined): boolean {
  return typeof verdict === "string" && /^\s*pass\b/i.test(verdict);
}

/** Where a request stands against its budget (design §16.8). */
export interface ReviewBudgetState {
  tier: Tier;
  /** The tier's budget, the owner's. */
  budget: number;
  /** Σ of the request's `{ calls: n }` grants. */
  granted: number;
  /** `budget + granted`. */
  ceiling: number;
  /** The one count, now (`requestReviewCountOf`). */
  calls: number;
  /** The batches a live `{ untilClean: b }` grant covers. */
  untilClean: Set<string>;
  /** The tool calls of every batch an untilClean grant covers, live or spent (`exemptCallsOf`): left out of the comparison. */
  exempt: number;
}

/** The sum of a request's `{ calls: n }` grants. */
export function grantedCallsOf(request: Pick<RegisteredRequest, "reviews">): number {
  return request.reviews.grants.reduce((sum, grant) => sum + (grant.calls ?? 0), 0);
}

/** The deps the budget reads with: the data folder and a Paseo handle (the agent list). */
interface BudgetDeps {
  home: string;
  paseo: unknown;
  log: (message: string) => void;
}

/**
 * The request's budget state now, or null when its tier is not known (no
 * report record yet). Rejects when the trace store cannot be read.
 */
export async function reviewBudgetStateOf(deps: BudgetDeps, request: RegisteredRequest): Promise<ReviewBudgetState | null> {
  if (request.tier === null) return null;
  const { calls, trace } = await requestReviewCountOf(
    { location: { tracesDir: join(deps.home, TRACES_DIR_NAME) }, paseo: deps.paseo as DashboardPaseo, home: deps.home },
    request.workspaceId,
    request.requestId,
  );
  const budget = readReviewBudget({ home: deps.home, log: deps.log })[request.tier];
  const granted = grantedCallsOf(request);
  const untilClean = liveUntilCleanBatchesOf(deps.home, request, trace);
  return { tier: request.tier, budget, granted, ceiling: reviewCeilingOf(budget, granted), calls, untilClean, exempt: exemptCallsOf(request) };
}

type GrantedRequest = Pick<RegisteredRequest, "workspaceId" | "requestId" | "reviews">;

/**
 * The batches of the request's `{ untilClean: b }` grants that have not passed
 * yet: the live ones (§16.8). A pass on the trace settles one; the outbox is
 * read once, and only for the rest. Never throws.
 */
export function liveUntilCleanBatchesOf(home: string, request: GrantedRequest, trace: Pick<ReconstructedTrace, "reviews"> | null): Set<string> {
  const passedOnTrace = (batchId: string): boolean => trace?.reviews.some((review) => review.batchId === batchId && isPassVerdict(review.verdict)) === true;
  const open = [...new Set(request.reviews.grants.map((grant) => grant.untilCleanBatch))].filter(
    (batchId): batchId is string => batchId !== null && !passedOnTrace(batchId),
  );
  if (open.length === 0) return new Set();
  let passed: Set<string>;
  try {
    passed = new Set(
      createOutbox(home)
        .list(request.workspaceId)
        .filter(
          (record) =>
            record.kind === "review" &&
            record.requestId === request.requestId &&
            record.batchId !== null &&
            parseReviews(record.text, { agentId: record.from, at: record.createdAt }).some((review) => isPassVerdict(review.verdict)),
        )
        .map((record) => record.batchId!),
    );
  } catch {
    passed = new Set();
  }
  return new Set(open.filter((batchId) => !passed.has(batchId)));
}

/**
 * The tool calls of every batch an `{ untilClean: b }` grant covers, live or
 * spent (§16.8): the owner granted that batch what it needs, so its calls
 * never count against the ceiling — before or after it passes, so whether
 * another batch is allowed never depends on when b passed. They still count
 * in the displayed review count. Pure.
 */
export function exemptCallsOf(request: Pick<RegisteredRequest, "reviews">): number {
  const covered = new Set(request.reviews.grants.map((grant) => grant.untilCleanBatch).filter((batchId): batchId is string => batchId !== null));
  return request.reviews.batches.filter((batch) => covered.has(batch.batchId)).reduce((sum, batch) => sum + batch.calls.length, 0);
}

/**
 * The request's grants as every budget check reads them (§16.8): the
 * Orchestrator's `review.over-budget` rule (`RuleInput.reviewGrant`), the
 * Manager's notice (`overrunOf`) and, through `reviewBudgetStateOf`, the
 * tools — the sum of its `{ calls: n }` grants and the calls of every
 * batch an untilClean grant covers. Pure.
 */
export function ruleReviewGrantOf(request: Pick<RegisteredRequest, "reviews">): RuleReviewGrant {
  return { calls: grantedCallsOf(request), exempt: exemptCallsOf(request) };
}

/**
 * The refusal of one more call of `batchId`, or null when it may go (§16.8): a
 * batch a live untilClean grant covers always may; any other call may while
 * the count after it, its exempt calls left out, stays within the ceiling.
 */
export function budgetRefusal(state: ReviewBudgetState, requestId: string, batchId: string): string | null {
  if (state.untilClean.has(batchId) || !overReviewCeiling(state.calls + 1, state.exempt, state.ceiling)) return null;
  return budgetRefusalOf({ requestId, calls: state.calls, budget: state.ceiling, tier: state.tier, batchId });
}

/**
 * Clears the request's create calls whose Reviewer never appeared within
 * `PENDING_TTL_MS` of the call (design §16.8): a batch with no Reviewer and
 * only such a call is free again. Returns the request as it stands after.
 * Throws when the registry cannot be written.
 */
export function clearStaleCreateCalls(home: string, request: RegisteredRequest, now: Date, log: (message: string) => void): RegisteredRequest {
  const stale = request.reviews.batches
    .filter((batch) => batch.reviewerIds.length === 0)
    .flatMap((batch) => batch.calls.filter((call) => isEmptyCreateCall(call) && now.getTime() - (Date.parse(call.at) || 0) > PENDING_TTL_MS));
  if (stale.length === 0) return request;
  const registry = createRequestRegistry(home, { log });
  for (const call of stale) {
    registry.removeReviewCall(request.workspaceId, request.requestId, call.callId);
    log(`[paseo-bm] the review call ${call.callId} of ${request.requestId} created no Reviewer in time; its batch is free again.`);
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
// The grant (design §16.8).
// ---------------------------------------------------------------------------

/**
 * Appends the grant of every answered `review-budget` decision of `decisions`
 * to its request (design §16.8): the chosen option's `grant`; an option
 * without one, or an answer in the owner's words, grants nothing. Once per
 * decision. The settlement hook calls it for every answer — the owner's on a
 * card or in a chat, and the policy's (`bm_decide`) where `cost` is delegated;
 * a precedent never answers one. Returns the decisions whose grant was added.
 * Never throws: a failure is one log line.
 */
export function applyReviewBudgetGrants(
  decisions: readonly Decision[],
  deps: { home?: string | null; log?: (message: string) => void } = {},
): string[] {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const added: string[] = [];
  const grants = decisions.filter((decision) => decision.subject === REVIEW_BUDGET_SUBJECT && decision.status === "answered" && decision.requestId !== null);
  if (grants.length === 0) return added;
  let home: string | null;
  try {
    home = deps.home !== undefined ? deps.home : resolveDataHome().home;
  } catch {
    home = null;
  }
  if (home === null) return added;
  for (const decision of grants) {
    // A precedent never answers it (design §16.8): should one ever have, it grants nothing.
    if (decision.answer === null || decision.answer.by === "precedent") continue;
    const key = decision.answer.optionKey;
    const grant = key === null ? undefined : decision.options.find((option) => option.key === key)?.grant;
    if (grant === undefined) continue;
    // The owner's policy grants at most { calls: 2 } (bm_decide refuses more); should one ever have, it grants nothing.
    if (decision.answer.by === "policy" && !policyMayGrant(grant)) {
      log(`[paseo-bm] the review-budget answer of ${decision.id} by the owner's policy grants more than it may; nothing was granted.`);
      continue;
    }
    try {
      const outcome = createRequestRegistry(home, { log }).addGrant(decision.workspaceId, decision.requestId!, {
        decisionId: decision.id,
        calls: "calls" in grant ? grant.calls : null,
        untilCleanBatch: "untilClean" in grant ? grant.untilClean : null,
      });
      if (outcome === "added") added.push(decision.id);
      else if (outcome === "no-request") log(`[paseo-bm] the review-budget grant of ${decision.id} names request ${decision.requestId}, which the registry does not hold; nothing was granted.`);
    } catch (error) {
      log(`[paseo-bm] could not record the review-budget grant of ${decision.id}: ${reasonOf(error)}`);
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
}

type BoundWorker = BoundCaller & { requestId: string };

function boundWorkerOf(caller: ToolCaller | null): BoundWorker | null | "no-request" {
  const worker = boundAs(caller, "worker");
  if (worker === null) return null;
  return worker.requestId === null ? "no-request" : (worker as BoundWorker);
}

/** The `reviewCalls` a tool answers after its call: `<n> of <ceiling>`, the call counted (the tools of a request run one at a time). */
function callsAfter(before: ReviewBudgetState): string {
  return `${before.calls + 1} of ${before.ceiling}`;
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

  /** The request and its budget, or the refusal. */
  const standing = async (
    home: string,
    paseo: unknown,
    worker: BoundWorker,
    nothing: string,
  ): Promise<{ request: RegisteredRequest; state: ReviewBudgetState } | ServerToolAnswer> => {
    const request = registryOf(home).get(worker.workspaceId, worker.requestId);
    if (request === null) return refused(`paseo-bm knows no request ${worker.requestId} in this workspace, so it cannot count its review calls; tell the owner in one line. ${nothing}`);
    let state: ReviewBudgetState | null;
    try {
      state = await reviewBudgetStateOf({ home, paseo, log }, request);
    } catch (error) {
      return refused(`paseo-bm could not count the review calls of ${request.requestId} (${reasonOf(error)}); try again in a moment. ${nothing}`);
    }
    if (state === null) return refused(NO_REPORT_YET_MESSAGE);
    return { request, state };
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
    const home = deps.home();
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_REVIEW_MESSAGE);
    // A Reviewer gets Paseo's tools only when it is created, and a Worker without them could not cancel it (§16.6).
    if (await agentToolsOff(paseo)) return refused(AGENT_TOOLS_OFF_TOOL_MESSAGE);
    const nothing = "Nothing was created.";

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
      const over = budgetRefusal(state, request.requestId, typed.batchId);
      if (over !== null) return refused(over);
      const profile = await profileOf(paseo, REVIEWER_PROFILE_ID, log);
      if (profile === null) return refused(NO_REVIEWER_PROFILE_MESSAGE);
      // The Worker's own folder, read from Paseo — never a folder the agent typed.
      const cwd = await folderOfAgent(paseo, worker.agentId, worker.workspaceId);
      if (cwd === null) return refused(`paseo-bm could not read your folder from Paseo; try again in a moment. ${nothing}`);

      // The call, recorded under the registry's write before anything is created.
      // A call id in the outbox's shape (`out-<12 hex>`, design §16.4).
      const callId = (deps.outbox?.newId ?? newRecordId)();
      const brief = reviewerBriefOf({ requestId: request.requestId, batchId: typed.batchId, stages: typed.stages, scope: typed.scope, checks: typed.checks ?? null });
      try {
        const recorded = registryOf(home).addReviewCall(
          worker.workspaceId,
          request.requestId,
          typed.batchId,
          { callId, kind: "create", reviewerId: "", at: now().toISOString() },
          brief,
        );
        if (recorded === "batch-taken") return refused(`Batch ${typed.batchId} already has a Reviewer: use bm_rereview for its re-review, or open a new batch. ${nothing}`);
        if (recorded !== "added") return refused(`paseo-bm knows no request ${request.requestId} in this workspace; tell the owner in one line. ${nothing}`);
      } catch (error) {
        return refused(`paseo-bm could not write its request registry (${reasonOf(error)}); nothing was created. Tell the owner in one line.`);
      }

      let reviewerId: string;
      try {
        // The Reviewer rules, as a Worker's Runtime facts name them (§7.2): the action boundary of the project included.
        const project = await creationProjectOf(cwd, { workspaceId: worker.workspaceId }, log);
        const facts = await modeFactsOf("worker", paseo, cwd, log, project.boundary);
        const modeId = facts.reviewerModeNone === true ? null : (facts.reviewerModeId ?? null);
        const base = (await aliasBases(paseo))[REVIEWER_PROFILE_ID] ?? null;
        ({ reviewerId } = await createPluginReviewer(
          paseo as ReviewerCreationPaseo,
          {
            workspaceId: worker.workspaceId,
            requestId: request.requestId,
            workerId: worker.agentId,
            batchId: typed.batchId,
            cwd,
            prompt: reviewerPromptOf(request.requestId, typed.batchId, callId, brief),
            alias: REVIEWER_PROFILE_ID,
            model: profile.model,
            base,
            modeId,
            callId,
          },
          { home, binder: deps.binder?.(), log },
        ));
      } catch (error) {
        // Paseo's refusal, verbatim but for a token path (design §16.5: a token never reaches an agent or a log).
        const reason = withoutTokenPaths(reasonOf(error));
        // Paseo threw after the hook kept the token: the Reviewer may exist. The call stays, so its
        // agent.created names it (creation-settle.ts); otherwise it is cleared after PENDING_TTL_MS.
        if (creationMayExist(error)) {
          const named = registryOf(home)
            .get(worker.workspaceId, request.requestId)
            ?.reviews.batches.find((entry) => entry.batchId === typed.batchId)
            ?.calls.find((call) => call.callId === callId && call.reviewerId !== "");
          if (named !== undefined) return answered({ reviewerId: named.reviewerId, batchId: typed.batchId, reviewCalls: callsAfter(state) });
          log(`[paseo-bm] ${CREATE_REVIEWER_TOOL}: Paseo answered the Reviewer of batch ${typed.batchId} for Worker ${worker.agentId} with an error after it may have created it: ${reason}`);
          return refused(
            `Paseo answered with an error after it may have created the Reviewer: ${reason}. If the Reviewer appears, its review reaches you as usual; if not, batch ${typed.batchId} is free again in ${PENDING_TTL_MS / 60_000} minutes, or open a new batch.`,
          );
        }
        // A failed creation removes its call: it never happened.
        try {
          registryOf(home).removeReviewCall(worker.workspaceId, request.requestId, callId);
        } catch (removal) {
          log(`[paseo-bm] could not remove the failed review call ${callId} of ${request.requestId}: ${reasonOf(removal)}`);
        }
        log(`[paseo-bm] ${CREATE_REVIEWER_TOOL} could not create the Reviewer of batch ${typed.batchId} for Worker ${worker.agentId}: ${reason}`);
        return refused(`Paseo refused to create the Reviewer: ${reason}. ${nothing}`);
      }

      return answered({ reviewerId, batchId: typed.batchId, reviewCalls: callsAfter(state) });
    });
  };

  // -------------------------------------------------------------------------
  // bm_rereview.
  // -------------------------------------------------------------------------

  /** The newest live Reviewer of a batch, or why there is none. */
  const liveReviewerOf = async (paseo: unknown, batch: ReviewBatch): Promise<{ reviewerId: string } | { archived: string } | null> => {
    const newest = batch.reviewerIds.at(-1);
    if (newest === undefined) return null;
    try {
      const ref = (paseo as { agents?: { ref?(id: string): { refresh?(): Promise<{ agent?: unknown } | null> } } }).agents?.ref?.(newest);
      const snapshot = asRecord((await ref?.refresh?.())?.agent);
      if (snapshot === null || nonEmpty(snapshot["archivedAt"]) !== null) return { archived: newest };
      return { reviewerId: newest };
    } catch {
      // Unreadable: the delivery's own drop path tells a gone target.
      return { reviewerId: newest };
    }
  };

  const rereview = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const worker = boundWorkerOf(caller);
    if (worker === null) return refused(REVIEW_NOT_BOUND_MESSAGE);
    if (worker === "no-request") return refused("paseo-bm does not know your request, so it cannot send a re-review; tell the owner in one line and stop. Nothing was sent.");
    const input = withoutNulls(raw);
    const shape = schemaIssues(REREVIEW_FACE.inputSchema, input);
    if (shape.length > 0) return fixThese(REREVIEW_TOOL, shape);
    const { batchId, fixed } = input as { batchId: string; fixed: string };
    const home = deps.home();
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_REVIEW_MESSAGE);
    const nothing = "Nothing was sent.";

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
      const target = await liveReviewerOf(paseo, batch);
      if (target === null) return refused(`Batch ${batchId} has no Reviewer yet: create it with bm_create_reviewer. ${nothing}`);
      if ("archived" in target) return refused(`Reviewer ${target.archived} of batch ${batchId} is archived: create a new batch with bm_create_reviewer. ${nothing}`);
      const found = await standing(home, paseo, worker, nothing);
      if ("ok" in found) return found;
      const { request, state } = found;
      // One re-review per batch, unless a live untilClean grant covers it (§16.8).
      if (batch.calls.some((call) => call.kind === "rereview") && !state.untilClean.has(batchId)) {
        return refused(
          `Batch ${batchId} has had its one re-review. Ask the owner with bm_questions (subject "review-budget", class "cost", an option with grant { untilClean: "${batchId}" }), or report the batch as it stands. ${nothing}`,
        );
      }
      const over = budgetRefusal(state, request.requestId, batchId);
      if (over !== null) return refused(over);

      // The record first (§16.7), then its call under its id, then the delivery.
      const outboxDeps = outboxDepsOf(home, { ...deps, now, log }, paseo);
      const outbox = createOutbox(home, outboxDeps);
      let record: OutboxRecord;
      try {
        record = outbox.add(worker.workspaceId, {
          kind: "message",
          requestId: request.requestId,
          batchId,
          from: worker.agentId,
          to: target.reviewerId,
          text: `${rereviewLineOf(batchId)}\n${fixed.replace(/\r\n/g, "\n").trim()}`,
        });
      } catch (error) {
        return refused(`paseo-bm could not store your re-review (${reasonOf(error)}); nothing was sent. Tell the owner in one line.`);
      }
      try {
        const recorded = registryOf(home).addReviewCall(worker.workspaceId, request.requestId, batchId, {
          callId: record.id,
          kind: "rereview",
          reviewerId: target.reviewerId,
          at: record.createdAt,
        });
        if (recorded !== "added") throw new Error(`the registry answered ${recorded}`);
      } catch (error) {
        // Never sent without its call: the record is closed so no reload sends it either.
        try {
          outbox.settle(worker.workspaceId, record.id, "dropped", "its review call could not be recorded");
        } catch {
          // Left pending, it would be sent after a reload; the log says why it was not now.
        }
        return refused(`paseo-bm could not record the review call (${reasonOf(error)}); nothing was sent. Tell the owner in one line.`);
      }
      const outcome = await deliverRecord(worker.workspaceId, record, outboxDeps);
      const delivery = deliveryOf(outcome);
      if (delivery === "dropped") {
        // A failed send removes its call.
        try {
          registryOf(home).removeReviewCall(worker.workspaceId, request.requestId, record.id);
        } catch (error) {
          log(`[paseo-bm] could not remove the undelivered review call ${record.id} of ${request.requestId}: ${reasonOf(error)}`);
        }
        return refused(`paseo-bm could not deliver the re-review to Reviewer ${target.reviewerId}; it was not counted. Create a new batch with bm_create_reviewer, or tell the owner in one line.`);
      }
      return answered({ reviewerId: target.reviewerId, delivery, reviewCalls: callsAfter(state) });
    });
  };

  return actingTools([CREATE_REVIEWER_FACE, REREVIEW_FACE], { [CREATE_REVIEWER_TOOL]: create, [REREVIEW_TOOL]: rereview }, "Nothing was created or sent");
}
