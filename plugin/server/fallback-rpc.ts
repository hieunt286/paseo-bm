/**
 * The fallback incidents' server side (delta 20260921 §4.4.6, §4.4.10, REQ-065 c).
 *
 * - A new `pending` incident becomes the owner's decision `f:<incidentId>`
 *   (autonomy design §A.5 d, `fallback-decisions.ts`); answering it runs
 *   `fallback.act` below. The Manager is not told: it relays nothing.
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
 * Handlers throw only coded `DashboardError`s.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { unusableDataHomeMessage } from "./data-home";
import { autoActionOf, holdFallbackDecision, syncFallbackDecisions } from "./fallback-decisions";
import { onFallbackIncident, readIncidents, updateIncidents } from "./fallback-state";
import { FALLBACK_NOTICE_MARKER } from "./notices";
import { providerId } from "./provider-id";
import { reasonOf } from "./role-choices";
import { dataHomeOf } from "./role-extras";
import { FALLBACK_CLASS_LABELS } from "../shared/bm-fallback";
import { DashboardError, fallbackActRpc, fallbackIncidentsRpc, type FallbackActInput, type FallbackIncident } from "../shared/contracts";

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
export { AUTO_WAIT_WINDOW_MS, autoActionOf } from "./fallback-decisions";

export interface FallbackRpcDeps {
  /** The data folder; the plugin looks it up, tests pass one. */
  home?: string | null;
  now?: () => Date;
  log?: (message: string) => void;
}

/** The data folder, or `null` when there is none; `deps.home` stands in for it in tests. */
function homeOf(deps: FallbackRpcDeps): string | null {
  return deps.home !== undefined ? deps.home : dataHomeOf();
}

/** Handler body of `fallback.incidents`: oldest first; an unreadable file or unknown home reads as none. */
export async function handleFallbackIncidents(
  input: { workspaceId?: string; ids?: string[] },
  paseo: unknown,
  deps: FallbackRpcDeps = {},
): Promise<{ incidents: FallbackIncident[] }> {
  const home = homeOf(deps);
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
  const home = homeOf(deps);
  if (home === null) throw new DashboardError("E_FALLBACK_NOT_FOUND", `${unusableDataHomeMessage()}; see Settings → Data`);
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
    const home = homeOf(deps);
    if (home === null) throw new DashboardError("E_FALLBACK_NOT_FOUND", `${unusableDataHomeMessage()}; see Settings → Data`);
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
 * Runs the `auto` policy's choice for a new incident through `fallback.act`,
 * so it takes the same lock and the same checks as a click. Opens no
 * decision. Returns true when an action ran (a failure is logged, and the
 * incident is as the action left it); false when nothing was chosen and the
 * incident stays pending. Never throws.
 */
export async function decideAutomatically(
  incident: FallbackIncident,
  paseo: unknown,
  deps: FallbackRpcDeps & { actions: FallbackActions },
): Promise<boolean> {
  const log = deps.log ?? defaultLog;
  const action = autoActionOf(incident, (deps.now ?? (() => new Date()))());
  if (action === null) return false;
  try {
    await handleFallbackAct({ incidentId: incident.id, action }, paseo, deps);
  } catch (error) {
    log(`[paseo-bm] the Auto switch policy could not ${action} for incident ${incident.id}: ${reasonOf(error)}`);
  }
  return true;
}

/**
 * Registers `fallback.incidents` and `fallback.act`, and turns every new
 * `pending` incident into the owner's decision `f:<incidentId>` (§A.5 d) —
 * after the `auto` policy has run its choice, if the role has it (§4.6): the
 * incident is held meanwhile, so it gets a decision only when the policy left
 * it pending. `onPaseo` hears each handler's SDK handle (the wait timers are
 * set again from it, §4.4.9). Returns the remover of that listener.
 */
export function registerFallbackRpcs(
  server: PluginServerContext,
  actions: FallbackActions = {},
  options: { onPaseo?: (paseo: unknown) => void } = {},
): () => void {
  const seen = (paseo: unknown) => {
    try {
      options.onPaseo?.(paseo);
    } catch {
      // Setting the wait timers again never fails a card action.
    }
  };
  server.handle(fallbackIncidentsRpc, (input, context) => {
    seen(context.paseo);
    return handleFallbackIncidents(input, context.paseo);
  });
  server.handle(fallbackActRpc, (input, context) => {
    seen(context.paseo);
    return handleFallbackAct(input, context.paseo, { actions });
  });
  return onFallbackIncident(async (incident, paseo, context) => {
    if (incident.status !== "pending") return;
    if (context?.policy === "auto") {
      const release = holdFallbackDecision(incident.id);
      try {
        await decideAutomatically(incident, paseo, { actions, home: context.home });
      } finally {
        release();
      }
    }
    syncFallbackDecisions(context.home);
  });
}
