/**
 * The Orchestrator's RPCs (Orchestrator design §8). Every `orchestrator.*`
 * handler is registered here: each one is an exported `handle…` function that
 * takes its input and an injectable `OrchestratorRpcDeps`, plus one line in
 * `registerOrchestratorRpcs`.
 *
 * The first design's RPCs (the nudge settings, flags, overview and the
 * per-request assessment) are gone (design §11), and so is the one that
 * appended a workflow assessment's suggestion to a role's additional
 * instructions, retired with them (autonomy design §B.8).
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { DataHomeDeps } from "./data-home";
import { registerOrchestratorStateRpcs, type OrchestratorStateDeps } from "./orchestrator-state";
import { registerOrchestratorAgentRpcs } from "./orchestrator-agent";
import { withPaseoTap } from "./rpc-kit";

/**
 * Everything the handlers take from outside, injectable so a test runs on a
 * temporary data folder; `orchestrator-state.ts` adds the clock.
 * `onPaseo` hears the Paseo handle of every
 * `orchestrator.*` call before its handler runs: the stall pass has no
 * context of its own and takes its handle from there (design §6).
 */
export type OrchestratorRpcDeps = DataHomeDeps &
  OrchestratorStateDeps & {
    onPaseo?: (paseo: unknown) => void;
  };

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

/** Every handler's Paseo handle goes to `onPaseo` first (rpc-kit `withPaseoTap`); a failing `onPaseo` never fails the call. */
export function registerOrchestratorRpcs(host: PluginServerContext, deps: OrchestratorRpcDeps = {}): void {
  const server = withPaseoTap(host, deps.onPaseo);
  // design §3.3: `orchestrator.open-preview` and `orchestrator.open` (orchestrator-agent.ts).
  registerOrchestratorAgentRpcs(server, deps);
  // design §8: state (orchestrator-state.ts).
  registerOrchestratorStateRpcs(server, deps);
}
