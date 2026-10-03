/**
 * Fallback for a stopped Reviewer (delta 20260921 §4.5.1, REQ-066 b; design
 * §16.9).
 *
 * **A bound Worker's Reviewer** (its Worker was bound with the creation tools
 * and the registry holds the Reviewer's batch): on **Switch** the plugin
 * creates the replacement itself (`createPluginReviewer`, as
 * `bm_create_reviewer` does) — `bm-reviewer-fallback-<n>/<model>`, the
 * Reviewer mode rules, `parent` = the Worker, labels `bm.role`,
 * `bm.requestId`, `bm.batchId`, `bm.version`, `bm.replaces`, a bound token
 * for the same batch — with the batch's stored brief behind a `BM-BRIEF
 * reviewer` line carrying the replaced call's `callId`: the same review call,
 * counted once, and never off-tool. The incident is `switched` with the
 * replacement, the old Reviewer gets `bm.replacedBy`, and the Worker an
 * informational `BM-FALLBACK`: its review reaches it as a delivery, as before.
 *
 * **An unbound Worker** keeps today's recipe. A Reviewer it created is heard
 * only through Paseo's wake of its creator, so a Reviewer the plugin created
 * would never reach it: on **Switch** the plugin creates NO agent: it marks
 * the incident `switched` and sends the parent Worker (through the notice
 * queue) a `BM-FALLBACK` whose closing lines are the exact `create_agent`
 * call to make — alias, mode, thinking, labels with `bm.replaces` — and the
 * instruction to send the new Reviewer, unchanged, the review message the old
 * one got.
 *
 * When that Reviewer appears (`agent.created`, `bm.replaces` = the old
 * Reviewer of a `switched` incident), the incident records its id and the old
 * Reviewer gets `bm.replacedBy`. If the notice queue was lost (a plugin reload)
 * before the Worker got the instructions, the card offers **Resend to Worker**,
 * which sends the same message again.
 */
import { liveBindingOf, type AgentBinder, type BindingStore } from "./agent-bindings";
import { folderOfAgent } from "./create-worker";
import { unusableDataHomeMessage } from "./data-home";
import { createRequestRegistry, newestCallOf, type ReviewBatch } from "./request-registry";
import { createPluginReviewer, reviewerPromptOf, type ReviewerCreationPaseo } from "./review-tools";
import { aliasBases, decidePending, fallbackNotice, type FallbackAction, type FallbackRpcDeps } from "./fallback-rpc";
import { readIncidents, updateIncidents } from "./fallback-state";
import { FALLBACK_NOTICE_MARKER } from "./notices";
import { enqueue as defaultEnqueue, type NoticeOutcome, type NoticePaseo } from "./notice-queue";
import { setAgentLabels, type CliResult } from "./paseo-cli";
import { parentOf, roleOfProvider } from "./agent-role";
import { asRecord, availableProviders, nonEmpty, reasonOf } from "./role-choices";
import { REVIEWER_FALLBACK_MODE, REVIEWER_FALLBACK_PROVIDERS, dataHomeOf } from "./role-instructions";
import { capabilityOf, chooseModeId, featuresFor, modesFor, runPostureOf } from "./role-mode";
import { DashboardError, type FallbackIncident } from "../shared/contracts";

/** Label a replacement agent carries: the id of the agent it replaces. */
const REPLACES_LABEL = "bm.replaces";
const REQUEST_ID_LABEL = "bm.requestId";
const REPLACED_BY_LABEL = "bm.replacedBy";

/**
 * The instructions the Worker gets for a switched Reviewer (agent-facing, so
 * English, word for word). `mode` null → the "do not pass" wording (a provider
 * without modes); `thinking` null → the thinking clause is left out.
 */
export function reviewerInstructions(incident: FallbackIncident, mode: string | null, thinking: string | null): string {
  const candidate = incident.candidate!;
  const old = incident.agentId;
  return [
    `The user chose to replace Reviewer ${old}. Create the new Reviewer now with create_agent:`,
    `provider \`${candidate.alias}/${candidate.model}\`, ${mode === null ? "do not pass settings.modeId" : `settings.modeId \`${mode}\``},`,
    `${thinking === null ? "" : `settings.thinkingOptionId \`${thinking}\`, `}and the labels you give any Reviewer plus \`${REPLACES_LABEL}\` = \`${old}\`.`,
    `Send it, unchanged, the message you sent ${old}. This is the same review call, not a new one.`,
  ].join("\n");
}

/**
 * The mode the replacement Reviewer is created in, for the candidate's alias:
 * the posture rule for an untiered provider (§4.2.2), the hook's Reviewer rule
 * for a tiered one (never `dangerous` / `planning`), null for a provider
 * without modes. Modes that cannot be read: the entry's own mode, else `auto`
 * on Claude or Codex, else null (Paseo then answers with its own list).
 */
export async function reviewerModeFor(
  paseo: unknown,
  candidate: NonNullable<FallbackIncident["candidate"]>,
  log: (message: string) => void,
): Promise<string | null> {
  const modes = await modesFor(paseo, candidate.alias, log);
  const capability = capabilityOf(modes);
  if (capability === "none") return null;
  if (capability === "tiered") return chooseModeId("reviewer", modes!, undefined, candidate.modeId) ?? null;
  if (capability === "untiered") {
    const features = await featuresFor(paseo, `${candidate.alias}/${candidate.model}`, undefined, log);
    return runPostureOf("reviewer", capability, modes!, features, candidate.modeId)?.modeId ?? candidate.modeId;
  }
  return candidate.modeId ?? (REVIEWER_FALLBACK_PROVIDERS.includes(candidate.baseProvider) ? REVIEWER_FALLBACK_MODE : null);
}

export interface ReviewerFallbackDeps {
  log?: (message: string) => void;
  now?: () => Date;
  enqueue?: (targetId: string, kind: string, text: string, paseo?: NoticePaseo) => Promise<NoticeOutcome>;
  /** `setAgentLabels` of `paseo-cli.ts` by default. */
  setLabels?: (agentId: string, labels: Record<string, string>) => Promise<CliResult>;
  /** The data folder (tests); looked up otherwise. */
  home?: string | null;
  /**
   * The per-agent bindings (design §16.5): a Worker bound with the creation
   * tools gets its replacement Reviewer from the plugin (§16.9). None: every
   * Worker keeps the recipe.
   */
  bindings?: () => BindingStore | null;
  /** Binds the replacement Reviewer (the endpoint's binder); none (unbound) when absent. */
  binder?: AgentBinder;
}

/** The informational line a bound Worker gets once its Reviewer was replaced (design §16.9). */
export function replacedReviewerLine(oldId: string, newId: string, batchId: string): string {
  return `Reviewer ${oldId} was replaced by ${newId} for batch ${batchId}; its review reaches you as before.`;
}

/** Title of a replacement Reviewer the plugin creates. */
export const FALLBACK_REVIEWER_TITLE = "Beads Reviewer (fallback)";

/**
 * The batch of a bound Worker's Reviewer (design §16.9): the Worker is bound
 * with the creation tools and the registry holds a batch of the request with
 * that Reviewer; null otherwise (the recipe). Never throws.
 */
export function boundBatchOf(
  incident: FallbackIncident,
  home: string,
  bindings: BindingStore | null,
  log: (message: string) => void,
): { requestId: string; batch: ReviewBatch } | null {
  try {
    if (bindings === null || incident.parentId === null) return null;
    const worker = liveBindingOf(bindings.list(), incident.parentId, "worker");
    if (worker === null) return null;
    const requestId = worker.requestId ?? incident.requestId;
    if (requestId === null) return null;
    const request = createRequestRegistry(home, { log }).get(incident.workspaceId, requestId);
    const batch = request?.reviews.batches.find((entry) => entry.reviewerIds.includes(incident.agentId));
    return batch === undefined ? null : { requestId, batch };
  } catch {
    return null;
  }
}

/**
 * The plugin creates the replacement of a bound Worker's Reviewer (design
 * §16.9) and decides the incident; see the module comment. A creation that
 * fails records `failed`, so a repeated click never creates two.
 */
async function switchBoundReviewer(
  incident: FallbackIncident,
  bound: { requestId: string; batch: ReviewBatch },
  paseo: unknown,
  home: string,
  deps: ReviewerFallbackDeps & { now: () => Date; log: (message: string) => void },
): Promise<FallbackIncident> {
  const { log, now } = deps;
  const candidate = incident.candidate!;
  const workerId = incident.parentId!;
  const { requestId, batch } = bound;
  // The call it replaces: the batch's newest; the new Reviewer's first line carries its id, so it is counted once.
  const call = newestCallOf(batch);
  if (call === undefined) throw new DashboardError("E_FALLBACK_CREATE_FAILED", `batch ${batch.batchId} of ${requestId} has no review call to hand over`);
  const cwd = await folderOfAgent(paseo, workerId, incident.workspaceId);
  if (cwd === null) throw new DashboardError("E_FALLBACK_CREATE_FAILED", `the folder of Worker ${workerId} cannot be read; try again`);
  const mode = await reviewerModeFor(paseo, candidate, log);
  let reviewerId: string;
  try {
    ({ reviewerId } = await createPluginReviewer(
      paseo as ReviewerCreationPaseo,
      {
        workspaceId: incident.workspaceId,
        requestId,
        workerId,
        batchId: batch.batchId,
        cwd,
        prompt: reviewerPromptOf(requestId, batch.batchId, call.callId, batch.brief),
        alias: candidate.alias,
        model: candidate.model,
        base: candidate.baseProvider,
        modeId: mode,
        thinkingOptionId: candidate.thinkingOptionId,
        labels: { [REPLACES_LABEL]: incident.agentId },
        title: FALLBACK_REVIEWER_TITLE,
      },
      { home, binder: deps.binder, log },
    ));
  } catch (error) {
    const detail = `could not create the fallback Reviewer on ${candidate.alias}/${candidate.model}: ${reasonOf(error)}`;
    await decidePending(home, incident.id, (entry) => ({ ...entry, status: "failed", decidedAt: now().toISOString(), error: detail }), log);
    throw new DashboardError("E_FALLBACK_CREATE_FAILED", detail);
  }
  try {
    const labelled = await (deps.setLabels ?? ((id: string, labels: Record<string, string>) => setAgentLabels(id, labels)))(incident.agentId, { [REPLACED_BY_LABEL]: reviewerId });
    if (!labelled.ok) log(`[paseo-bm] could not label Reviewer ${incident.agentId} as replaced by ${reviewerId}: ${labelled.reason}`);
  } catch (error) {
    log(`[paseo-bm] could not label Reviewer ${incident.agentId} as replaced by ${reviewerId}: ${reasonOf(error)}`);
  }
  const switched = await decidePending(
    home,
    incident.id,
    (entry) => ({ ...entry, status: "switched", decidedAt: now().toISOString(), replacementId: reviewerId }),
    log,
  );
  // Information only: the review reaches the Worker as a delivery (§16.7), as before.
  const bases = await aliasBases(paseo);
  const text = fallbackNotice(switched, (alias) => bases[alias] ?? null, replacedReviewerLine(incident.agentId, reviewerId, batch.batchId));
  const outcome = await (deps.enqueue ?? defaultEnqueue)(workerId, FALLBACK_NOTICE_MARKER, text, paseo as NoticePaseo);
  if (outcome === "dropped") log(`[paseo-bm] the Worker ${workerId} could not be told that Reviewer ${incident.agentId} was replaced by ${reviewerId}.`);
  return switched;
}

/** Sends the Worker its BM-FALLBACK with the instructions; the outcome of the queue. */
async function tellWorker(incident: FallbackIncident, paseo: unknown, deps: ReviewerFallbackDeps): Promise<NoticeOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const candidate = incident.candidate!;
  const mode = await reviewerModeFor(paseo, candidate, log);
  const bases = await aliasBases(paseo);
  const text = fallbackNotice(incident, (alias) => bases[alias] ?? null, reviewerInstructions(incident, mode, candidate.thinkingOptionId));
  const outcome = await (deps.enqueue ?? defaultEnqueue)(incident.parentId!, FALLBACK_NOTICE_MARKER, text, paseo as NoticePaseo);
  if (outcome === "dropped") log(`[paseo-bm] the Worker ${incident.parentId} could not be told to replace Reviewer ${incident.agentId}; the card offers Resend to Worker.`);
  return outcome;
}

/**
 * The `switch` action for a Reviewer (§4.5.1): no agent is created. The
 * incident must have a candidate whose provider is still available and a
 * parent Worker; it becomes `switched` (no replacement yet) and the Worker is
 * sent its instructions.
 */
export function createReviewerSwitch(deps: ReviewerFallbackDeps = {}): FallbackAction {
  const log = deps.log ?? ((message: string) => console.warn(message));
  return async (incident, paseo, rpcDeps: FallbackRpcDeps) => {
    const now = rpcDeps.now ?? deps.now ?? (() => new Date());
    const home = rpcDeps.home ?? null;
    if (home === null) throw new DashboardError("E_FALLBACK_NOT_FOUND", `${unusableDataHomeMessage()}; see Settings → Data`);
    if (incident.role !== "reviewer") throw new DashboardError("E_FALLBACK_NO_CANDIDATE", `not a Reviewer incident (${incident.role})`);
    const candidate = incident.candidate;
    if (candidate === null) throw new DashboardError("E_FALLBACK_NO_CANDIDATE", "the fallback chain has no entry left for this Reviewer");
    if (incident.parentId === null) throw new DashboardError("E_FALLBACK_CREATE_FAILED", `the Worker of Reviewer ${incident.agentId} is not known`);
    const available = await availableProviders(paseo);
    if (available !== null && !available.has(candidate.baseProvider)) {
      throw new DashboardError("E_FALLBACK_NO_CANDIDATE", `${candidate.baseProvider} is not available in Paseo right now`);
    }
    // Design §16.9: a bound Worker's Reviewer is replaced by the plugin itself.
    const bound = boundBatchOf(incident, home, deps.bindings?.() ?? null, log);
    if (bound !== null) return switchBoundReviewer(incident, bound, paseo, home, { ...deps, now, log });
    const switched = await decidePending(home, incident.id, (entry) => ({ ...entry, status: "switched", decidedAt: now().toISOString() }), log);
    await tellWorker(switched, paseo, deps);
    return switched;
  };
}

/** The `resend` action (§7): the same instructions to the Worker again; the incident does not change. */
export function createReviewerResend(deps: ReviewerFallbackDeps = {}): FallbackAction {
  return async (incident, paseo) => {
    if (incident.candidate === null || incident.parentId === null) {
      throw new DashboardError("E_FALLBACK_CREATE_FAILED", `nothing to resend for incident ${incident.id}`);
    }
    const outcome = await tellWorker(incident, paseo, deps);
    if (outcome === "dropped") throw new DashboardError("E_FALLBACK_CREATE_FAILED", `the Worker ${incident.parentId} could not be reached`);
    return incident;
  };
}

/**
 * On `agent.created`: when the new agent is a Reviewer carrying `bm.replaces`
 * = the old Reviewer of a `switched` incident without a replacement, record
 * its id and label the old Reviewer `bm.replacedBy`. The label alone is not
 * trusted (review b7): the new Reviewer must be in the incident's workspace,
 * a child of the incident's Worker, and — when both carry one — of the same
 * request; otherwise another workspace's or request's Reviewer could claim
 * the incident and change its review count. Returns the incident it
 * completed, or null. Never throws.
 */
export async function linkReplacementReviewer(
  agentId: string,
  provider: unknown,
  paseo: unknown,
  deps: ReviewerFallbackDeps = {},
): Promise<FallbackIncident | null> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    if (roleOfProvider(provider) !== "reviewer") return null;
    const ref = (paseo as { agents: { ref(id: string): { refresh(): Promise<{ agent?: unknown } | null> } } }).agents.ref(agentId);
    const snapshot = asRecord((await ref.refresh())?.agent);
    const labels = asRecord(snapshot?.["labels"]) ?? {};
    const replaces = nonEmpty(labels[REPLACES_LABEL]);
    if (replaces === null) return null;
    const workspaceId = nonEmpty(snapshot?.["workspaceId"]);
    const parentId = parentOf(snapshot);
    const requestId = nonEmpty(labels[REQUEST_ID_LABEL]);
    const home = deps.home === undefined ? dataHomeOf() : deps.home;
    if (home === null) return null;
    const match = (incident: FallbackIncident) =>
      incident.role === "reviewer" &&
      incident.status === "switched" &&
      incident.agentId === replaces &&
      incident.replacementId === null &&
      // Same workspace, same Worker, and the same request when both name one.
      workspaceId === incident.workspaceId &&
      parentId !== null &&
      parentId === incident.parentId &&
      (requestId === null || incident.requestId === null || requestId === incident.requestId);
    if (!readIncidents(home, log).incidents.some(match)) return null;
    let linked: FallbackIncident | null = null;
    await updateIncidents(
      home,
      (incidents) => {
        const index = incidents.findIndex(match);
        if (index === -1) return null;
        linked = { ...incidents[index]!, replacementId: agentId };
        return incidents.map((incident, at) => (at === index ? linked! : incident));
      },
      log,
    );
    if (linked === null) return null;
    const labelled = await (deps.setLabels ?? ((id: string, labels: Record<string, string>) => setAgentLabels(id, labels)))(replaces, { [REPLACED_BY_LABEL]: agentId });
    if (!labelled.ok) log(`[paseo-bm] could not label Reviewer ${replaces} as replaced by ${agentId}: ${labelled.reason}`);
    return linked;
  } catch (error) {
    log(`[paseo-bm] linking the replacement Reviewer ${agentId} failed: ${reasonOf(error)}`);
    return null;
  }
}
