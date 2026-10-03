import type { PluginLifecycleEvents, PluginServerContext } from "@getpaseo/plugin/server";
import { REVIEWER_STOP_NOTICE_PREFIX, WORKER_STOP_NOTICE } from "./notices";
import { PARENT_AGENT_LABEL, listAllAgents, roleOfAgent, roleOfProvider } from "./agent-role";
import { cancelAgent, type CancelResult } from "./paseo-cli";
import { errorText } from "./rpc-kit";

/**
 * Stop propagation from a Beads Worker to its running Reviewers (bm-wq6, REQ-026f).
 *
 * When the user stops a Worker (app Stop button or `paseo stop`), Paseo
 * interrupts only the Worker's turn; a Reviewer the Worker created keeps
 * running. The SDK gives plugins no agent cancel, but the Paseo CLI does:
 * since spike S5 (ADR-027 decisions 8 and 10, design §16.12) each running
 * Reviewer is cancelled with `paseo agent stop <id>` through `paseo-cli.ts`
 * (`cancelAgent`). Only when that cancel fails — no `paseo` binary, an id that
 * is not a whole one, a CLI error — is the failure logged and the Reviewer
 * asked instead: `PaseoAgentHandle.send()` replaces its turn with the fixed
 * stop notice, which says itself what to do.
 *
 * SDK facts this relies on (checked against @getpaseo/plugin 0.8.0 and
 * @getpaseo/client 0.8.0 typings, not guessed):
 * - `on("agent.turn_ended", (event, { paseo, signal }) => …)`; the event carries
 *   `agent: { id, workspaceId, provider, … }` and `outcome`, whose `kind` is
 *   `completed`, `failed` or `canceled` (lifecycle.d.ts).
 * - `canceled` does not tell a user stop from a message that replaced the
 *   turn, so the Worker is re-read with `agents.ref(id).refresh()`: `running`
 *   means a new turn already started and nothing is done.
 * - `agents.list({ filter: { labels, includeArchived }, page })` pages like
 *   `manager.ts`; the result is filtered again here, never trusted.
 *
 * Lifecycle belongs to the user (ADR-005): nothing here archives or deletes.
 */

/** `bm.role` value that identifies a Reviewer (Technical Design §7.1). */
export const REVIEWER_ROLE_VALUE = "reviewer";

/**
 * Wait before the single re-check of a Worker that still reads `running` right
 * after its turn was canceled: the half-second poll interval the retired
 * installer CLI used; it is not a new product timeout.
 */
export const STOP_RECHECK_MS = 500;

/**
 * The notice a running Reviewer of a stopped Worker gets when the plugin could
 * not cancel it. Self-contained since spike S5: `roles/reviewer.md` no longer
 * carries a stop answer of its own. Its first words are the notice marker
 * (`REVIEWER_STOP_NOTICE_PREFIX`); keep them.
 */
export const REVIEWER_STOP_NOTICE =
  `${REVIEWER_STOP_NOTICE_PREFIX} by the user. Stop this review now: do not read files, run commands or call any tool; reply with one line saying you stopped, and end your turn.`;

/** Cancels one agent's running turn; `cancelAgent` of `paseo-cli.ts` by default. */
export type CancelAgent = (agentId: string) => Promise<CancelResult>;

const defaultCancel: CancelAgent = (agentId) => cancelAgent(agentId);

const LOG_PREFIX = "[paseo-bm] stop propagation:";

// ---------------------------------------------------------------------------
// Minimal, injectable view of the Paseo SDK. `PaseoApi` from @getpaseo/client
// is structurally assignable to it (registerStopPropagation passes the real
// one, which `npm run typecheck:plugin` checks); tests pass a fake.
// ---------------------------------------------------------------------------

export interface StopAgentSnapshot {
  id: string;
  workspaceId?: string;
  status: string;
  labels: Record<string, string>;
  /** Provider selection; decides the role when the `bm.role` label is missing (delta 20260918g). */
  provider?: string;
  archivedAt?: string | null;
}

export interface StopAgentHandle {
  refresh(): Promise<{ agent: StopAgentSnapshot } | null>;
  send(text: string): Promise<void>;
}

export interface StopPaseo {
  agents: {
    list(options: {
      filter: { labels?: Record<string, string>; includeArchived: boolean };
      page: { limit: number; cursor?: string };
    }): Promise<{
      entries: Array<{ agent: StopAgentSnapshot }>;
      pageInfo: { nextCursor: string | null; hasMore: boolean };
    }>;
    ref(agentId: string): StopAgentHandle;
  };
}

export type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];

export interface StopPropagationContext {
  paseo: StopPaseo;
  signal?: AbortSignal;
  /** The Reviewer cancel; `cancelAgent` of `paseo-cli.ts` by default. */
  cancel?: CancelAgent;
}

/** The options of `stopRunningReviewers`. */
export interface StopReviewersOptions {
  signal?: AbortSignal;
  /** The Reviewer cancel; `cancelAgent` of `paseo-cli.ts` by default. */
  cancel?: CancelAgent;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Resolves after `ms`, or at once when `signal` aborts. Never rejects. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (isAborted(signal)) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The event is the end of a canceled turn of a Worker (`bm-worker`, or a fallback Worker alias). */
export function isCanceledWorkerTurn(event: TurnEndedEvent): boolean {
  const candidate = event as Partial<TurnEndedEvent> | null | undefined;
  return (
    candidate?.outcome?.kind === "canceled" &&
    typeof candidate.agent?.id === "string" &&
    roleOfProvider(candidate.agent.provider) === "worker"
  );
}

/** A live, running Reviewer created by `workerId` in `workspaceId` (when known). */
function isRunningReviewerOf(
  agent: StopAgentSnapshot | null | undefined,
  workerId: string,
  workspaceId: string | null,
): agent is StopAgentSnapshot {
  if (!agent) return false;
  const labels = agent.labels ?? {};
  return (
    labels[PARENT_AGENT_LABEL] === workerId &&
    // By the bm-reviewer provider; the bm.role label does not decide (design §16.3).
    roleOfAgent(agent)?.role === REVIEWER_ROLE_VALUE &&
    !agent.archivedAt &&
    agent.status === "running" &&
    (workspaceId === null || agent.workspaceId === workspaceId)
  );
}

async function readStatus(paseo: StopPaseo, agentId: string): Promise<StopAgentSnapshot | null> {
  const result = await paseo.agents.ref(agentId).refresh();
  return result?.agent ?? null;
}

/** Every running Reviewer of the Worker, walking all pages. */
async function listRunningReviewers(
  paseo: StopPaseo,
  workerId: string,
  workspaceId: string | null,
): Promise<StopAgentSnapshot[]> {
  // Filtered on the parent only: a Reviewer without the bm.role label is still
  // a Reviewer when its provider is bm-reviewer (delta 20260918g §4.2).
  const children = await listAllAgents((options) => paseo.agents.list(options), {
    labels: { [PARENT_AGENT_LABEL]: workerId },
    includeArchived: false,
  });
  return children.filter((agent) => isRunningReviewerOf(agent, workerId, workspaceId));
}

/**
 * Stops one running Reviewer: cancels its turn through the Paseo CLI (spike
 * S5); when the cancel fails, logs why (the agent id and the CLI's reason,
 * never a token) and asks it with `REVIEWER_STOP_NOTICE` instead. Returns how
 * it was stopped. Throws only when that send throws.
 */
export async function stopReviewer(
  handle: Pick<StopAgentHandle, "send">,
  reviewerId: string,
  cancel: CancelAgent,
  log: (message: string) => void,
): Promise<"cancelled" | "asked"> {
  let result: CancelResult;
  try {
    result = await cancel(reviewerId);
  } catch (error) {
    result = { ok: false, reason: errorText(error) };
  }
  if (result.ok) return "cancelled";
  log(`${LOG_PREFIX} could not cancel Reviewer ${reviewerId} (${result.reason}); asking it to stop instead.`);
  await handle.send(REVIEWER_STOP_NOTICE);
  return "asked";
}

/**
 * Stops every running Reviewer of `workerId` (in `workspaceId` when known):
 * re-reads each one just before and skips it unless it is still running, then
 * cancels it (`stopReviewer`: the stop notice only when the cancel fails).
 * Returns the ids it stopped or asked. Never throws: a failure costs one log
 * line; an aborted `signal` ends it quietly. Also used when a fallback Worker
 * replaces a stopped one (delta 20260921 §4.4.7).
 */
export async function stopRunningReviewers(
  paseo: StopPaseo,
  workerId: string,
  workspaceId: string | null,
  options: StopReviewersOptions = {},
): Promise<string[]> {
  const signal = options.signal;
  const cancel = options.cancel ?? defaultCancel;
  const stopped: string[] = [];
  let reviewers: StopAgentSnapshot[];
  try {
    reviewers = await listRunningReviewers(paseo, workerId, workspaceId);
  } catch (error) {
    if (!isAborted(signal)) {
      console.warn(`${LOG_PREFIX} could not list the Reviewers of Worker ${workerId}: ${errorText(error)}`);
    }
    return stopped;
  }
  for (const reviewer of reviewers) {
    if (isAborted(signal)) return stopped;
    try {
      const handle = paseo.agents.ref(reviewer.id);
      const fresh = await handle.refresh();
      if (isAborted(signal)) return stopped;
      if (!isRunningReviewerOf(fresh?.agent, workerId, workspaceId)) continue;
      await stopReviewer(handle, reviewer.id, cancel, (message) => console.warn(message));
      stopped.push(reviewer.id);
    } catch (error) {
      if (isAborted(signal)) return stopped;
      console.warn(`${LOG_PREFIX} could not stop Reviewer ${reviewer.id} of Worker ${workerId}: ${errorText(error)}`);
    }
  }
  return stopped;
}

/**
 * Handler body of `on("agent.turn_ended")`. Resolves in every case: failures are
 * logged with `console.warn`, an aborted `signal` ends it quietly.
 *
 * 1. Ignore anything but a canceled turn of a `bm-worker`.
 * 2. Re-read the Worker; if it is `running`, wait `STOP_RECHECK_MS` once and
 *    read again. Still `running` means a message replaced the turn: stop here.
 * 3. List the Worker's running, non-archived Reviewer children in its
 *    workspace; re-read each one just before and skip it unless it is still
 *    running; cancel it (`stopReviewer`: the stop notice only when the cancel
 *    fails).
 */
export async function propagateWorkerStop(
  event: TurnEndedEvent,
  context: StopPropagationContext,
): Promise<void> {
  const signal = context?.signal;
  try {
    if (!isCanceledWorkerTurn(event) || isAborted(signal)) return;
    const { paseo } = context;
    const workerId = event.agent.id;

    let worker: StopAgentSnapshot | null;
    try {
      worker = await readStatus(paseo, workerId);
      if (isAborted(signal)) return;
      if (worker?.status === "running") {
        await wait(STOP_RECHECK_MS, signal);
        if (isAborted(signal)) return;
        worker = await readStatus(paseo, workerId);
        if (isAborted(signal)) return;
        if (worker?.status === "running") return;
      }
    } catch (error) {
      if (!isAborted(signal)) {
        console.warn(`${LOG_PREFIX} could not re-read Worker ${workerId}: ${errorText(error)}`);
      }
      return;
    }

    const workspaceId = event.agent.workspaceId ?? worker?.workspaceId ?? null;
    await stopRunningReviewers(paseo, workerId, workspaceId, {
      ...(signal === undefined ? {} : { signal }),
      ...(context.cancel === undefined ? {} : { cancel: context.cancel }),
    });
  } catch (error) {
    if (!isAborted(signal)) {
      console.warn(`${LOG_PREFIX} unexpected failure: ${errorText(error)}`);
    }
  }
}

/** The part of the server context this hook needs; `on` is absent on older hosts. */
export type StopPropagationHost = Partial<Pick<PluginServerContext, "on" | "before">>;

/**
 * Registers the `on("agent.turn_ended")` hook and returns its remover. On a host
 * without `on` it returns a no-op and logs one line — unless the host has no
 * lifecycle hooks at all (no `before` either), where `registerRoleHook` has
 * already logged the one line for that host.
 */
export function registerStopPropagation(host: StopPropagationHost, deps: { cancel?: CancelAgent } = {}): () => void {
  if (typeof host.on !== "function") {
    if (typeof host.before === "function") {
      console.warn(
        "[paseo-bm] this Paseo host has no on(\"agent.turn_ended\") hook; stopping a Worker will not stop its running Reviewers.",
      );
    }
    return () => {};
  }
  const remove = host.on("agent.turn_ended", (event, context) =>
    propagateWorkerStop(event, { paseo: context?.paseo, signal: context?.signal, ...(deps.cancel === undefined ? {} : { cancel: deps.cancel }) }),
  );
  return typeof remove === "function" ? remove : () => {};
}

// ---------------------------------------------------------------------------
// `/bm-worker-stop-all` (delta 20260917e §4.4).
// ---------------------------------------------------------------------------

/** Label value of a Beads Worker. */
export const WORKER_ROLE_VALUE = "worker";

export interface StopAllResult {
  /** Workers the notice reached. */
  workers: number;
  /** Reviewers the notice reached. */
  reviewers: number;
  /** Candidates that were archived, closed or no longer running when re-read. */
  skipped: number;
}

/**
 * Every non-archived agent of one role in one workspace, walking all pages.
 *
 * Listed with no label filter and decided by `roleOfAgent`, which reads the
 * provider only (design §16.3): a Worker or Reviewer started without the
 * bm.role label is found, and a label alone never makes an agent one. The role
 * is decided per agent here, never by the daemon's filter, so nothing this
 * command never promised to touch — the Manager above all — can slip in.
 */
async function listByRole(paseo: StopPaseo, role: string, workspaceId: string): Promise<StopAgentSnapshot[]> {
  const all = await listAllAgents((options) => paseo.agents.list(options), { includeArchived: false });
  return all.filter(
    (agent) => agent && roleOfAgent(agent)?.role === role && !agent.archivedAt && agent.workspaceId === workspaceId,
  );
}

/**
 * Asks every running Worker of one workspace to stop, and stops its running
 * Reviewers.
 *
 * **A Worker is asked, not forced:** `send()` on a running agent replaces the
 * turn it is in with `BM-STOP`, so the Worker reports `stopped` by its stop
 * rule. Everything downstream — the command's reply to the user, the wording
 * in the role files — has to say "asked to stop", never "stopped". **A
 * Reviewer is cancelled** through the Paseo CLI (spike S5, `stopReviewer`),
 * and asked with the stop notice only when that cancel fails.
 *
 * Three rules the loop exists to keep:
 * - **The Manager is never touched.** It is the user's point of contact, and the
 *   command's own name only promises Workers. Only the worker and reviewer
 *   roles are ever collected, by provider (design §16.3).
 * - **One workspace only** (owner decision Q28). A machine-wide stop is too
 *   large a consequence for one mistyped line.
 * - **An archived agent is skipped**, because `send()` would UN-archive it, and
 *   ADR-005 says agents belong to the user. Each candidate is re-read
 *   immediately before the send, so an agent archived or finished since the
 *   listing is skipped too rather than resurrected.
 */
export async function stopAllInWorkspace(
  paseo: StopPaseo,
  workspaceId: string,
  log: (message: string) => void = (message) => console.warn(message),
  cancel: CancelAgent = defaultCancel,
): Promise<StopAllResult> {
  const result: StopAllResult = { workers: 0, reviewers: 0, skipped: 0 };
  const targets: Array<{ agent: StopAgentSnapshot; role: string; notice: string }> = [
    ...(await listByRole(paseo, WORKER_ROLE_VALUE, workspaceId)).map((agent) => ({
      agent,
      role: WORKER_ROLE_VALUE,
      notice: WORKER_STOP_NOTICE,
    })),
    ...(await listByRole(paseo, REVIEWER_ROLE_VALUE, workspaceId)).map((agent) => ({
      agent,
      role: REVIEWER_ROLE_VALUE,
      notice: REVIEWER_STOP_NOTICE,
    })),
  ];

  for (const target of targets) {
    // Re-read: the listing is a moment old, and `send()` on an agent archived
    // in between would bring it back (ADR-005).
    const fresh = await readStatus(paseo, target.agent.id);
    if (!fresh || fresh.archivedAt || fresh.status !== "running") {
      result.skipped += 1;
      continue;
    }
    try {
      const handle = paseo.agents.ref(target.agent.id);
      if (target.role === WORKER_ROLE_VALUE) {
        await handle.send(target.notice);
        result.workers += 1;
      } else {
        await stopReviewer(handle, target.agent.id, cancel, log);
        result.reviewers += 1;
      }
    } catch (error) {
      result.skipped += 1;
      log(`${LOG_PREFIX} could not ask ${target.agent.id} to stop (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  return result;
}
