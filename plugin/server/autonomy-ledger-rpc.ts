/**
 * `autonomy.ledger` (autonomy design §B.3, ADR-018): the agreement ledger of
 * `shared/autonomy-ledger.ts` over the decision store, served read-only to the
 * owner's screens (Insights → Autonomy).
 *
 * Reads only: the store is opened as a reader (a read never creates the
 * folder, never repairs a file) and nothing is sent to any agent. The ledger
 * is derived on every call (§B.9) and hands out numbers and times only, so an
 * unsettled decision's prediction never leaves the server this way.
 *
 * A class the policy demoted (§B.4) counts only the owner's answers given
 * since its last demotion; the delegated figures are whole.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agreementLedger } from "../shared/autonomy-ledger";
import { autonomyLedgerRpc, type AutonomyLedgerInput, type AutonomyLedgerOutput } from "../shared/contracts";
import { readAutonomyPolicy } from "./autonomy-rpc";
import { createDecisionStore } from "./decision-store";
import { READ_FAILED, coded, dataHome, type RpcHomeDeps, type RpcLogDeps } from "./rpc-kit";

/** `log`: where a skipped decisions file is reported; `console.warn` by default. */
export type AutonomyLedgerRpcDeps = RpcHomeDeps & RpcLogDeps;

/**
 * `autonomy.ledger`: the ledger of every project, or of `workspaceId`. No
 * usable data folder reads as none; a decisions folder that cannot be read
 * safely is `READ_FAILED` (`E_DATA_HOME_UNAVAILABLE`: a read, never a write
 * code; code review 2026-09-30 §3.2), as `decisions.list` reports it.
 */
export function handleAutonomyLedger(input: AutonomyLedgerInput, deps: AutonomyLedgerRpcDeps = {}): AutonomyLedgerOutput {
  const home = dataHome(deps);
  if (home === null) return { cells: [], delegated: [] };
  return coded(READ_FAILED, "read the decisions", () => {
    const decisions = createDecisionStore(home, deps.log === undefined ? {} : { log: deps.log }).list({
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      statuses: ["answered"],
    });
    const demotions = readAutonomyPolicy(deps).demotions;
    return agreementLedger(decisions, {
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(demotions === undefined ? {} : { demotions }),
    });
  });
}

export function registerAutonomyLedgerRpcs(server: PluginServerContext, deps: AutonomyLedgerRpcDeps = {}): void {
  server.handle(autonomyLedgerRpc, (input) => handleAutonomyLedger(input, deps));
}
