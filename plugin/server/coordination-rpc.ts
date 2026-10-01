/**
 * The owner's two Coordination RPCs (autonomy design §G.7, ADR-021),
 * `coordination.settings` and `coordination.set`, over the store of
 * `coordination-store.ts`; moved out of the store with the RPC kit (code
 * review 2026-09-30 §3.2).
 *
 * These settings are the owner's: the RPCs are called by Settings, and no
 * agent tool sets them. The Orchestrator can only propose a change, as a
 * decision whose option carries it (§G.4); that change is applied through
 * `set` on the owner's answer, never by the agent.
 *
 * `coordination.set` checks the change before the data folder is looked at;
 * then no usable data folder → `E_DATA_HOME_UNAVAILABLE`, and a newer or
 * unwritable store → `E_COORDINATION_WRITE_FAILED`. Every refusal writes
 * nothing. The owner turning compaction or handoff on ends its
 * `coordination-off` alert (the A-12 guard's, `coordination-guard.ts`): Settings
 * and an applied prepared change both come through here.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  coordinationSetRpc,
  coordinationSettingsRpc,
  type CoordinationSetOutput,
  type CoordinationSettingsOutput,
} from "../shared/contracts";
import { alertKeyOf } from "../shared/alerts";
import { DEFAULT_COORDINATION_SETTINGS, coordinationChangeSchema, reviewBudgetOf, type CoordinationSettings, type ReviewBudget } from "../shared/coordination";
import { createAlertStore } from "./alert-store";
import { createCoordinationStore, invalidCoordinationChange } from "./coordination-store";
import { coded, errorText, logOf, readOr, requireDataHome, type RpcHomeDeps, type RpcLogDeps } from "./rpc-kit";

/** Where the data folder is found, where an unreadable store is reported (`console.warn` by default), and the clock. */
export type CoordinationRpcDeps = RpcHomeDeps & RpcLogDeps & { now?: () => Date };

/**
 * The settings in effect, for the plugin's own readers (the advice cadence of
 * the event bus, the review budget). No usable data folder, or a store that
 * cannot be read, reads as the defaults: the unreadable store costs one log
 * line. Never throws.
 */
export function readCoordinationSettings(deps: CoordinationRpcDeps = {}): CoordinationSettings {
  return readOr(deps, "the coordination settings", DEFAULT_COORDINATION_SETTINGS, (home) => createCoordinationStore(home).read());
}

/**
 * The owner's review budget per tier (§G.7, change-008 C6) in effect: what the
 * budget notice, the stall pass, a fallback handover and a new Worker's
 * Runtime facts read. An unreadable store reads 2 / 2 / 4. Never throws.
 */
export function readReviewBudget(deps: CoordinationRpcDeps = {}): ReviewBudget {
  return reviewBudgetOf(readCoordinationSettings(deps));
}

/** `coordination.settings`: reads only. */
export function handleCoordinationSettings(deps: CoordinationRpcDeps = {}): CoordinationSettingsOutput {
  return { settings: readCoordinationSettings(deps), defaults: DEFAULT_COORDINATION_SETTINGS };
}

/**
 * `coordination.set`. The change is checked before the data folder is looked
 * at, so a refusal never depends on the machine; every refusal writes nothing.
 */
export function handleCoordinationSet(input: unknown, deps: CoordinationRpcDeps = {}): CoordinationSetOutput {
  const change = coordinationChangeSchema.safeParse(input);
  if (!change.success) throw invalidCoordinationChange(input);
  const home = requireDataHome(deps, "save");
  const store = createCoordinationStore(home, deps.now === undefined ? {} : { now: deps.now });
  const output = coded("E_COORDINATION_WRITE_FAILED", "save the coordination settings", () => ({ settings: store.set(input) }));
  if ((change.data.key === "compact.enabled" || change.data.key === "handoff.enabled") && change.data.value) {
    const mechanism = change.data.key === "compact.enabled" ? "compact" : "handoff";
    try {
      createAlertStore(home, deps.now === undefined ? {} : { now: deps.now }).clear(alertKeyOf("coordination-off", null, mechanism));
    } catch (error) {
      logOf(deps)(`[paseo-bm] turned ${mechanism} on but could not end its Inbox alert: ${errorText(error)}`);
    }
  }
  return output;
}

export function registerCoordinationRpcs(server: PluginServerContext, deps: CoordinationRpcDeps = {}): void {
  server.handle(coordinationSettingsRpc, () => handleCoordinationSettings(deps));
  server.handle(coordinationSetRpc, (input) => handleCoordinationSet(input, deps));
}
