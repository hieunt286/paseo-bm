import type { PluginLifecycleEvents, PluginServerContext } from "@getpaseo/plugin/server";
import { MANAGER_ROLE_LABEL, PARENT_AGENT_LABEL } from "./manager";
import { providerId } from "./provider-id";

/**
 * Stop propagation from a Beads Worker to its running Reviewers (bm-wq6, REQ-026f).
 *
 * When the user stops a Worker (app Stop button or `paseo stop`), Paseo 0.8
 * interrupts only the Worker's turn; a Reviewer the Worker created keeps
 * running. Paseo gives plugins no agent cancel, so the closest supported
 * interrupt is used: `PaseoAgentHandle.send()` on a running agent replaces its
 * current turn with a new one carrying a fixed stop notice, which
 * `roles/reviewer.md` answers with one line and no tool calls.
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

/** Provider id of a Beads Worker; `bm-worker/<model>` names it too. */
export const WORKER_PROVIDER_ID = "bm-worker";

/** `bm.role` value that identifies a Reviewer (design §5). */
export const REVIEWER_ROLE_VALUE = "reviewer";

/**
 * Wait before the single re-check of a Worker that still reads `running` right
 * after its turn was canceled. Mirrors the plugin poll interval of design §8
 * (`PLUGIN_POLL_INTERVAL_MS` in the CLI, which the plugin bundle cannot import);
 * it is not a new product timeout.
 */
export const STOP_RECHECK_MS = 500;

/**
 * The notice sent to each running Reviewer of a stopped Worker. `roles/reviewer.md`
 * recognises it verbatim; do not reword it without changing the role.
 */
export const REVIEWER_STOP_NOTICE =
  'STOP: The Beads Worker that created you was stopped by the user. Stop this review now: do not read files, run commands or call any tool; reply with the single line "BM-REVIEW STOPPED" and end your turn.';

/** Largest page the daemon directory query accepts (protocol: `limit.max(200)`). */
const LIST_PAGE_LIMIT = 200;

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
  archivedAt?: string | null;
}

export interface StopAgentHandle {
  refresh(): Promise<{ agent: StopAgentSnapshot } | null>;
  send(text: string): Promise<void>;
}

export interface StopPaseo {
  agents: {
    list(options: {
      filter: { labels: Record<string, string>; includeArchived: boolean };
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
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** The event is the end of a canceled turn of a `bm-worker` agent. */
export function isCanceledWorkerTurn(event: TurnEndedEvent): boolean {
  const candidate = event as Partial<TurnEndedEvent> | null | undefined;
  return (
    candidate?.outcome?.kind === "canceled" &&
    typeof candidate.agent?.id === "string" &&
    providerId(candidate.agent.provider) === WORKER_PROVIDER_ID
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
    labels[MANAGER_ROLE_LABEL] === REVIEWER_ROLE_VALUE &&
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
  const found: StopAgentSnapshot[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await paseo.agents.list({
      filter: {
        labels: { [PARENT_AGENT_LABEL]: workerId, [MANAGER_ROLE_LABEL]: REVIEWER_ROLE_VALUE },
        includeArchived: false,
      },
      page: cursor === undefined ? { limit: LIST_PAGE_LIMIT } : { limit: LIST_PAGE_LIMIT, cursor },
    });
    for (const { agent } of page.entries) {
      if (isRunningReviewerOf(agent, workerId, workspaceId)) found.push(agent);
    }
    if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
    cursor = page.pageInfo.nextCursor;
  }
  return found;
}

/**
 * Handler body of `on("agent.turn_ended")`. Resolves in every case: failures are
 * logged with `console.warn`, an aborted `signal` ends it quietly.
 *
 * 1. Ignore anything but a canceled turn of a `bm-worker`.
 * 2. Re-read the Worker; if it is `running`, wait `STOP_RECHECK_MS` once and
 *    read again. Still `running` means a message replaced the turn: stop here.
 * 3. List the Worker's running, non-archived `bm.role=reviewer` children in its
 *    workspace; re-read each one just before sending and skip it unless it is
 *    still running; send `REVIEWER_STOP_NOTICE`.
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
        console.warn(`${LOG_PREFIX} could not re-read Worker ${workerId}: ${describeError(error)}`);
      }
      return;
    }

    const workspaceId = event.agent.workspaceId ?? worker?.workspaceId ?? null;
    let reviewers: StopAgentSnapshot[];
    try {
      reviewers = await listRunningReviewers(paseo, workerId, workspaceId);
    } catch (error) {
      if (!isAborted(signal)) {
        console.warn(`${LOG_PREFIX} could not list the Reviewers of Worker ${workerId}: ${describeError(error)}`);
      }
      return;
    }

    for (const reviewer of reviewers) {
      if (isAborted(signal)) return;
      try {
        const handle = paseo.agents.ref(reviewer.id);
        const fresh = await handle.refresh();
        if (isAborted(signal)) return;
        if (!isRunningReviewerOf(fresh?.agent, workerId, workspaceId)) continue;
        await handle.send(REVIEWER_STOP_NOTICE);
      } catch (error) {
        if (isAborted(signal)) return;
        console.warn(
          `${LOG_PREFIX} could not stop Reviewer ${reviewer.id} of Worker ${workerId}: ${describeError(error)}`,
        );
      }
    }
  } catch (error) {
    if (!isAborted(signal)) {
      console.warn(`${LOG_PREFIX} unexpected failure: ${describeError(error)}`);
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
export function registerStopPropagation(host: StopPropagationHost): () => void {
  if (typeof host.on !== "function") {
    if (typeof host.before === "function") {
      console.warn(
        "[paseo-bm] this Paseo host has no on(\"agent.turn_ended\") hook; stopping a Worker will not stop its running Reviewers.",
      );
    }
    return () => {};
  }
  const remove = host.on("agent.turn_ended", (event, context) =>
    propagateWorkerStop(event, { paseo: context?.paseo, signal: context?.signal }),
  );
  return typeof remove === "function" ? remove : () => {};
}
