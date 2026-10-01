/**
 * The fallback incidents' server side (delta 20260921 §4.4.6, §4.4.10, REQ-065 c).
 *
 * - A new `pending` incident becomes the owner's decision `f:<incidentId>`
 *   (autonomy design §A.5 d, `fallback-decisions.ts`); answering it runs
 *   `fallback.act` below. The Manager is not told: it relays nothing. It is
 *   answered without the owner only by a precedent or the owner's autonomy
 *   policy (the role's Auto switch was retired, ADR-022 decision 4).
 * - `fallback.incidents`: the recorded incidents, filtered by workspace or ids
 *   (the Inbox reads them).
 * - `fallback.act`: `dismiss` ("I'll handle it") marks the incident
 *   `dismissed` and touches no agent. `switch` (§4.4.7) and `wait` (§4.4.9)
 *   are handed in by the modules that implement them; `resend` is the Inbox's
 *   Resend to Worker. After each action the decisions are aligned (an incident
 *   decided here withdraws its open decision).
 *
 * `fallbackNotice` writes the `BM-FALLBACK` block the Worker of a switched
 * Reviewer gets its instructions in (`fallback-reviewer.ts`, §4.5.1).
 *
 * Handlers throw only coded `DashboardError`s. No usable data folder is
 * `E_DATA_HOME_UNAVAILABLE`, as for every RPC (rpc-kit, code review
 * 2026-09-30 §3.2).
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createDecisionStore } from "./decision-store";
import { createFallbackDecisionDelivery, syncFallbackDecisions } from "./fallback-decisions";
import { onFallbackIncident, readIncidents, updateIncidents } from "./fallback-state";
import { FALLBACK_NOTICE_MARKER } from "./notices";
import { providerId } from "./provider-id";
import { dataHome, errorText, requireDataHome, tapPaseo, withPaseoTap } from "./rpc-kit";
import { FALLBACK_CLASS_LABELS } from "../shared/bm-fallback";
import { DashboardError, fallbackActRpc, fallbackIncidentsRpc, type FallbackActInput, type FallbackIncident } from "../shared/contracts";
import type { Decision } from "../shared/decisions";

/** Longest message line of the notice. */
export const NOTICE_MESSAGE_CHARS = 300;

const defaultLog = (message: string): void => console.warn(message);

/**
 * The `BM-FALLBACK` block of an incident, word for word (agent-facing, so
 * English). `baseOf` gives the base provider an alias extends (`null` when
 * unknown, written `unknown`). `closing` is what the agent is told to do: the
 * Worker of a switched Reviewer gets its instructions there (§4.5.1).
 */
export function fallbackNotice(incident: FallbackIncident, baseOf: (alias: string) => string | null, closing: string): string {
  const alias = providerId(incident.agentProvider) ?? incident.agentProvider;
  const message = incident.message.replace(/\s+/g, " ").trim().slice(0, NOTICE_MESSAGE_CHARS);
  const candidate =
    incident.candidate === null
      ? "none"
      : `${incident.candidate.alias} · ${incident.candidate.baseProvider} · ${incident.candidate.model} · thinking ${incident.candidate.thinkingOptionId ?? "provider default"}`;
  return [
    FALLBACK_NOTICE_MARKER,
    `incident: ${incident.id}`,
    `role: ${incident.role}`,
    `agent: ${incident.agentId}`,
    `requestId: ${incident.requestId ?? "none"}`,
    `status: ${incident.status}`,
    `class: ${FALLBACK_CLASS_LABELS[incident.class]}`,
    `provider: ${alias} (${baseOf(alias) ?? "unknown"}) · ${incident.agentModel ?? "unknown"}`,
    `message: ${message === "" ? "none" : message}`,
    `resetsAt: ${incident.resetsAt ?? "unknown"}`,
    `candidate: ${candidate}`,
    `replacement: ${incident.replacementId ?? "none"}`,
    "",
    closing,
  ].join("\n");
}

export { aliasBases } from "./alias-bases";

export interface FallbackRpcDeps {
  /** The data folder; the plugin looks it up, tests pass one. */
  home?: string | null;
  now?: () => Date;
  log?: (message: string) => void;
}

/** Handler body of `fallback.incidents`: oldest first; an unreadable file or unknown home reads as none. */
export async function handleFallbackIncidents(
  input: { workspaceId?: string; ids?: string[] },
  paseo: unknown,
  deps: FallbackRpcDeps = {},
): Promise<{ incidents: FallbackIncident[] }> {
  const home = dataHome(deps);
  if (home === null) return { incidents: [] };
  const ids = input?.ids === undefined ? null : new Set(input.ids);
  const incidents = readIncidents(home, deps.log ?? defaultLog).incidents.filter(
    (incident) => (input?.workspaceId === undefined || incident.workspaceId === input.workspaceId) && (ids === null || ids.has(incident.id)),
  );
  return { incidents };
}

/** One of the card's actions on a `pending` incident; returns the incident as written. */
export type FallbackAction = (incident: FallbackIncident, paseo: unknown, deps: FallbackRpcDeps) => Promise<FallbackIncident>;

/**
 * Moves one incident from `pending` under the incidents mutex: `change` gets
 * it and returns its new state. Throws `E_FALLBACK_NOT_FOUND` (unknown id, or
 * no usable incidents file) and `E_FALLBACK_NOT_PENDING`.
 */
export async function decidePending(
  home: string,
  incidentId: string,
  change: (incident: FallbackIncident) => FallbackIncident,
  log: (message: string) => void = defaultLog,
): Promise<FallbackIncident> {
  let decided: FallbackIncident | null = null;
  const written = await updateIncidents(
    home,
    (incidents) => {
      const index = incidents.findIndex((incident) => incident.id === incidentId);
      if (index === -1) throw new DashboardError("E_FALLBACK_NOT_FOUND", `no fallback incident ${incidentId}`);
      const current = incidents[index]!;
      if (current.status !== "pending") {
        throw new DashboardError("E_FALLBACK_NOT_PENDING", `incident ${incidentId} is ${current.status}, not pending`);
      }
      decided = change(current);
      return incidents.map((incident, at) => (at === index ? decided! : incident));
    },
    log,
  );
  if (written === null || decided === null) throw new DashboardError("E_FALLBACK_NOT_FOUND", "the fallback incidents file cannot be read");
  return decided;
}

/** `dismiss` ("I'll handle it", §4.4.10): `dismissed`, no agent touched. */
export const dismissIncident: FallbackAction = async (incident, _paseo, deps) => {
  const home = requireDataHome(deps, "dismiss the fallback incident");
  const now = (deps.now ?? (() => new Date()))().toISOString();
  return decidePending(home, incident.id, (current) => ({ ...current, status: "dismissed", decidedAt: now }), deps.log ?? defaultLog);
};

export interface FallbackActions {
  switch?: FallbackAction;
  wait?: FallbackAction;
  /** Sends a switched Reviewer's instructions to its Worker again (§4.5.1, §7). */
  resend?: FallbackAction;
}

let actionQueue: Promise<unknown> = Promise.resolve();

/** Runs `work` after every card action queued before it; a failure does not block the next one. */
function oneActionAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = actionQueue.then(work, work);
  actionQueue = run.catch(() => undefined);
  return run;
}

/**
 * Handler body of `fallback.act`. Card actions run ONE AT A TIME (review b6):
 * the incident is read and checked `pending` inside that lock, and the action
 * runs to its end before the next one reads it. So a Switch can never create a
 * Worker for an incident a concurrent Wait or Dismiss already decided, and a
 * second action on the same incident always finds it decided. Then, inside
 * the same lock and whatever the action did, the `f:` decisions are aligned
 * with the incidents: an incident decided here withdraws its open decision.
 * An action this build does not have yet fails with its coded error.
 */
export function handleFallbackAct(
  input: FallbackActInput,
  paseo: unknown,
  deps: FallbackRpcDeps & { actions?: FallbackActions } = {},
): Promise<{ incident: FallbackIncident }> {
  return oneActionAtATime(async () => {
    const home = requireDataHome(deps, "act on the fallback incident");
    try {
      return { incident: await actOn(input, home, paseo, deps) };
    } finally {
      syncFallbackDecisions(home, deps);
    }
  });
}

/** The checks and the action of `fallback.act`, inside its lock. */
async function actOn(
  input: FallbackActInput,
  home: string,
  paseo: unknown,
  deps: FallbackRpcDeps & { actions?: FallbackActions },
): Promise<FallbackIncident> {
  const found = readIncidents(home, deps.log ?? defaultLog).incidents.find((incident) => incident.id === input.incidentId);
  if (found === undefined) throw new DashboardError("E_FALLBACK_NOT_FOUND", `no fallback incident ${input.incidentId}`);
  const scoped = { ...deps, home };
  if (input.action === "resend") {
    // Only a switched Reviewer whose replacement never appeared.
    if (found.role !== "reviewer" || found.status !== "switched" || found.replacementId !== null) {
      throw new DashboardError("E_FALLBACK_NOT_PENDING", `incident ${found.id} has nothing to resend`);
    }
    if (deps.actions?.resend === undefined) throw new DashboardError("E_FALLBACK_CREATE_FAILED", "resending is not available in this build");
    return deps.actions.resend(found, paseo, scoped);
  }
  if (found.status !== "pending") throw new DashboardError("E_FALLBACK_NOT_PENDING", `incident ${found.id} is ${found.status}, not pending`);
  let action: FallbackAction;
  if (input.action === "dismiss") action = dismissIncident;
  else if (input.action === "switch") {
    if (deps.actions?.switch === undefined) throw new DashboardError("E_FALLBACK_CREATE_FAILED", "switching is not available in this build");
    action = deps.actions.switch;
  } else {
    if (deps.actions?.wait === undefined) throw new DashboardError("E_FALLBACK_NO_RESET", "waiting for the reset is not available in this build");
    action = deps.actions.wait;
  }
  return action(found, paseo, scoped);
}

/**
 * Registers `fallback.incidents` and `fallback.act`, and turns every new
 * `pending` incident into the owner's decision `f:<incidentId>` (§A.5 d).
 * `onPaseo` hears each handler's SDK handle (rpc-kit `withPaseoTap`; the wait
 * timers are set again from it, §4.4.9). `onDecisionsOpened` hears the
 * decisions that listener opened, as stored after a precedent or the policy
 * answered them (the event bus: a decision the owner's policy asks the
 * Orchestrator to decide or predict, autonomy design §A.8, §B.9); its failure
 * is one log line.
 * Returns the remover of that listener.
 */
export function registerFallbackRpcs(
  server: PluginServerContext,
  actions: FallbackActions = {},
  options: { onPaseo?: (paseo: unknown) => void; onDecisionsOpened?: (opened: Decision[], paseo: unknown) => unknown } = {},
): () => void {
  // Setting the wait timers again never fails a card action.
  const tapped = withPaseoTap(server, options.onPaseo);
  tapped.handle(fallbackIncidentsRpc, (input, context) => handleFallbackIncidents(input, context.paseo));
  tapped.handle(fallbackActRpc, (input, context) => handleFallbackAct(input, context.paseo, { actions }));
  return onFallbackIncident(async (incident, paseo, context) => {
    if (incident.status !== "pending") return;
    // Autonomy design §B.6, §B.5: an owner precedent, or the owner's policy where `environment` is delegated, may answer the
    // new decision; its action then runs through fallback.act, as the owner's would.
    const settle = createFallbackDecisionDelivery(
      (input, handle) => {
        tapPaseo(options.onPaseo, handle);
        return handleFallbackAct(input, handle, { actions, home: context.home });
      },
      { home: () => context.home },
    );
    const sync = syncFallbackDecisions(context.home, { settle: { onSettled: settle, paseo } });
    if (sync.opened.length === 0 || options.onDecisionsOpened === undefined) return;
    try {
      const store = createDecisionStore(context.home);
      await options.onDecisionsOpened(sync.opened.flatMap((id) => store.get(id) ?? []), paseo);
    } catch (error) {
      defaultLog(`[paseo-bm] the decisions of fallback incident ${incident.id} could not be told to the Orchestrator: ${errorText(error)}`);
    }
  });
}
