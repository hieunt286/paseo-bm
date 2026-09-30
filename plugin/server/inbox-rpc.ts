/**
 * The Inbox's server side (autonomy design §A.8, §A.12): `inbox.alerts`, the
 * open alerts of the alerts store (`alert-store.ts`) as the Inbox lists them.
 * The Inbox's decisions come from `decisions.list` (`decision-rpc.ts`).
 *
 * Reads only: an alert is raised and cleared by its producers (the stall pass,
 * the Worker watch, the role pairing check, the fallback decisions), never by
 * the Inbox. The handler takes an injectable `InboxRpcDeps`, like the
 * `decisions.*` handlers.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { INBOX_ALERTS_MAX, inboxAlertsRpc, type InboxAlertsInput, type InboxAlertsOutput } from "../shared/contracts";
import { ALERT_KINDS, type Alert } from "../shared/alerts";
import { createAlertStore } from "./alert-store";
import { resolveDataHome, type DataHomeDeps } from "./data-home";

export type InboxRpcDeps = DataHomeDeps & {
  /** Where an unreadable store is reported; `console.warn` by default. */
  log?: (message: string) => void;
  /**
   * Called with the RPC's Paseo handle at each read, before the store is read
   * and not waited for: the throttled outdated-agents pass
   * (`outdated-agents.ts`), whose alerts show from the next read on.
   */
  onRead?: (paseo: unknown) => unknown;
};

function homeOf(deps: DataHomeDeps): string | null {
  try {
    return resolveDataHome(deps).home;
  } catch {
    return null;
  }
}

function timeOf(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
}

/** `ALERT_KINDS` order, then oldest first; the key breaks a tie so the order is stable. */
export function inboxAlertOrder(a: Alert, b: Alert): number {
  return (
    ALERT_KINDS.indexOf(a.kind) - ALERT_KINDS.indexOf(b.kind) ||
    timeOf(a.since) - timeOf(b.since) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/**
 * `inbox.alerts`. No usable data folder, or a store that cannot be read (a
 * symlink below the data folder), reads as no alerts: the Inbox must still
 * show its decisions. The unreadable store costs one log line.
 */
export function handleInboxAlerts(input: InboxAlertsInput, deps: InboxRpcDeps = {}): InboxAlertsOutput {
  const home = homeOf(deps);
  if (home === null) return { alerts: [], truncated: false };
  let open: Alert[];
  try {
    open = createAlertStore(home).list({ open: true, ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }) });
  } catch (error) {
    (deps.log ?? ((message: string) => console.warn(message)))(
      `[paseo-bm] could not read the Inbox alerts: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { alerts: [], truncated: false };
  }
  const ordered = [...open].sort(inboxAlertOrder);
  return { alerts: ordered.slice(0, INBOX_ALERTS_MAX), truncated: ordered.length > INBOX_ALERTS_MAX };
}

export function registerInboxRpcs(server: PluginServerContext, deps: InboxRpcDeps = {}): void {
  server.handle(inboxAlertsRpc, (input, context) => {
    try {
      void deps.onRead?.((context as { paseo?: unknown } | undefined)?.paseo);
    } catch {
      // A producer's failure never costs the Inbox its alerts.
    }
    return handleInboxAlerts(input, deps);
  });
}
