/**
 * The fallback card's server side (delta 20260921 §4.4.6, §4.4.10, REQ-065 c).
 *
 * - `BM-FALLBACK`: a new `pending` incident with a `managerId` is told to that
 *   Manager's chat through the notice queue (the Manager may be running, F13),
 *   and so is every later decision, with its new `status` and `replacement`.
 *   The chat renders the block as a card; the card's state always comes from
 *   `fallback.incidents`, never from the text.
 * - `fallback.incidents`: the recorded incidents, filtered by workspace or ids.
 * - `fallback.act`: `dismiss` ("I'll handle it") marks the incident
 *   `dismissed` and touches no agent. `switch` (§4.4.7) and `wait` (§4.4.9)
 *   are handed in by the modules that implement them.
 *
 * Handlers throw only coded `DashboardError`s; the notice never throws.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { onFallbackIncident, readIncidents, updateIncidents } from "./fallback-state";
import { FALLBACK_NOTICE_MARKER } from "./notices";
import { enqueue as defaultEnqueue, type NoticeOutcome, type NoticePaseo } from "./notice-queue";
import { providerId } from "./provider-id";
import { asRecord, nonEmpty, reasonOf } from "./role-choices";
import { installHomeOf } from "./role-extras";
import { TIMED_OUT, withTimeout } from "./role-mode";
import { FALLBACK_CLASS_LABELS } from "../shared/bm-fallback";
import { DashboardError, fallbackActRpc, fallbackIncidentsRpc, type FallbackActInput, type FallbackIncident } from "../shared/contracts";

/** Longest message line of the notice. */
export const NOTICE_MESSAGE_CHARS = 300;

const defaultLog = (message: string): void => console.warn(message);

/**
 * The `BM-FALLBACK` block of an incident, word for word (agent-facing, so
 * English). `baseOf` gives the base provider an alias extends (`null` when
 * unknown, written `unknown`).
 */
export function fallbackNotice(incident: FallbackIncident, baseOf: (alias: string) => string | null): string {
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
    `The ${incident.role} stopped because of its provider plan. The user decides on the card in this chat. Tell the user in one line; do not create an agent yourself.`,
  ].join("\n");
}

/** The `extends` of every alias, from one `config.get()` under the lookup budget; `{}` when unreadable. Never throws. */
async function aliasBases(paseo: unknown): Promise<Record<string, string>> {
  const config = (paseo as { config?: { get?: unknown } } | null | undefined)?.config;
  if (typeof config?.get !== "function") return {};
  try {
    const result = await withTimeout(config.get.call(config) as Promise<{ config?: unknown } | null | undefined>);
    if (result === TIMED_OUT) return {};
    const out: Record<string, string> = {};
    for (const [id, entry] of Object.entries(asRecord(asRecord(result?.config)?.["providers"]) ?? {})) {
      const base = nonEmpty(asRecord(entry)?.["extends"]);
      if (base !== null) out[id] = base;
    }
    return out;
  } catch {
    return {};
  }
}

export interface FallbackNoticeDeps {
  enqueue?: (targetId: string, kind: string, text: string, paseo?: NoticePaseo) => Promise<NoticeOutcome>;
  log?: (message: string) => void;
}

/**
 * Tells the incident's Manager chat (kind `BM-FALLBACK`, through the notice
 * queue). No `managerId` → nothing (only the pill shows it). Never throws.
 */
export async function notifyFallback(incident: FallbackIncident, paseo: unknown, deps: FallbackNoticeDeps = {}): Promise<NoticeOutcome | null> {
  if (incident.managerId === null) return null;
  const log = deps.log ?? defaultLog;
  try {
    const bases = await aliasBases(paseo);
    const text = fallbackNotice(incident, (alias) => bases[alias] ?? null);
    return await (deps.enqueue ?? defaultEnqueue)(incident.managerId, FALLBACK_NOTICE_MARKER, text, paseo as NoticePaseo);
  } catch (error) {
    log(`[paseo-bm] telling ${incident.managerId} about fallback incident ${incident.id} failed: ${reasonOf(error)}`);
    return null;
  }
}

export interface FallbackRpcDeps extends FallbackNoticeDeps {
  /** The install home; the plugin looks it up, tests pass one. */
  home?: string | null;
  now?: () => Date;
}

/** The install home, raced against the lookup budget. */
async function homeOf(paseo: unknown, deps: FallbackRpcDeps): Promise<string | null> {
  if (deps.home !== undefined) return deps.home;
  const found = await withTimeout(installHomeOf(paseo));
  return found === TIMED_OUT ? null : found;
}

/** Handler body of `fallback.incidents`: oldest first; an unreadable file or unknown home reads as none. */
export async function handleFallbackIncidents(
  input: { workspaceId?: string; ids?: string[] },
  paseo: unknown,
  deps: FallbackRpcDeps = {},
): Promise<{ incidents: FallbackIncident[] }> {
  const home = await homeOf(paseo, deps);
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
  const home = await homeOf(_paseo, deps);
  if (home === null) throw new DashboardError("E_FALLBACK_NOT_FOUND", "paseo-bm cannot find its install home");
  const now = (deps.now ?? (() => new Date()))().toISOString();
  return decidePending(home, incident.id, (current) => ({ ...current, status: "dismissed", decidedAt: now }), deps.log ?? defaultLog);
};

export interface FallbackActions {
  switch?: FallbackAction;
  wait?: FallbackAction;
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
 * second action on the same incident always finds it decided. Then the Manager
 * chat is told the new status. An action this build does not have yet fails
 * with its coded error.
 */
export function handleFallbackAct(
  input: FallbackActInput,
  paseo: unknown,
  deps: FallbackRpcDeps & { actions?: FallbackActions } = {},
): Promise<{ incident: FallbackIncident }> {
  return oneActionAtATime(async () => {
    const home = await homeOf(paseo, deps);
    if (home === null) throw new DashboardError("E_FALLBACK_NOT_FOUND", "paseo-bm cannot find its install home");
    const found = readIncidents(home, deps.log ?? defaultLog).incidents.find((incident) => incident.id === input.incidentId);
    if (found === undefined) throw new DashboardError("E_FALLBACK_NOT_FOUND", `no fallback incident ${input.incidentId}`);
    if (found.status !== "pending") throw new DashboardError("E_FALLBACK_NOT_PENDING", `incident ${found.id} is ${found.status}, not pending`);
    const scoped = { ...deps, home };
    let action: FallbackAction;
    if (input.action === "dismiss") action = dismissIncident;
    else if (input.action === "switch") {
      if (deps.actions?.switch === undefined) throw new DashboardError("E_FALLBACK_CREATE_FAILED", "switching is not available in this build");
      action = deps.actions.switch;
    } else {
      if (deps.actions?.wait === undefined) throw new DashboardError("E_FALLBACK_NO_RESET", "waiting for the reset is not available in this build");
      action = deps.actions.wait;
    }
    const incident = await action(found, paseo, scoped);
    await notifyFallback(incident, paseo, deps);
    return { incident };
  });
}

/**
 * Registers `fallback.incidents` and `fallback.act`, and tells the Manager
 * chat about every new `pending` incident. `onPaseo` hears each handler's SDK
 * handle (the wait timers are set again from it, §4.4.9). Returns the remover
 * of that listener.
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
  return onFallbackIncident(async (incident, paseo) => {
    if (incident.status === "pending") await notifyFallback(incident, paseo);
  });
}
