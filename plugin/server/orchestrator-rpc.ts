/**
 * The Orchestrator's RPCs (Orchestrator design §8). Every `orchestrator.*`
 * handler lives here: each one is an exported `handle…` function that takes
 * its input and an injectable `OrchestratorRpcDeps`, plus one line in
 * `registerOrchestratorRpcs`.
 *
 * - `orchestrator.apply-suggestion` (design §8, REQ-076): the only path by
 *   which an assessment recommendation reaches a role's Additional
 *   instructions — appended, never replacing, and refused when the text
 *   changed since the client showed it.
 *
 * The first design's RPCs (the nudge settings, flags, overview and the
 * per-request assessment) are gone (design §11).
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  DashboardError,
  orchestratorApplySuggestionRpc,
  type OrchestratorApplySuggestionInput,
  type OrchestratorApplySuggestionOutput,
} from "../shared/contracts";
import { resolveDataHome, unusableDataHomeMessage, type DataHomeDeps } from "./data-home";
import { registerOrchestratorActionRpcs, type OrchestratorActionsDeps } from "./orchestrator-actions";
import { registerOrchestratorAgentRpcs } from "./orchestrator-agent";
import { extraHashOf } from "./role-extra-hash";
import { MAX_EXTRA_CHARS, fullInstructions, readRoleExtras, saveRoleExtra } from "./role-extras";

/**
 * Everything the handlers take from outside, injectable so a test runs on a
 * temporary data folder; `orchestrator-actions.ts` adds the queue and the clock.
 * `onPaseo` hears the Paseo handle of every
 * `orchestrator.*` call before its handler runs: the stall pass has no
 * context of its own and takes its handle from there (design §6).
 */
export type OrchestratorRpcDeps = DataHomeDeps &
  OrchestratorActionsDeps & {
    onPaseo?: (paseo: unknown) => void;
  };

// ---------------------------------------------------------------------------
// orchestrator.apply-suggestion
// ---------------------------------------------------------------------------

/**
 * `current`, one blank line, then `text`. `current` is kept byte for byte as
 * the prefix: only the separator adapts to the newlines it already ends with.
 */
export function appendSuggestion(current: string, text: string): string {
  if (current === "") return text;
  const separator = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${separator}${text}`;
}

/**
 * `orchestrator.apply-suggestion` (design §8, REQ-076): appends one suggestion
 * to a role's Additional instructions, through `saveRoleExtra`.
 *
 * - No usable data folder fails `E_DATA_HOME_UNAVAILABLE`.
 * - `expectedHash` different from the hash of the stored text fails
 *   `E_ROLE_EXTRA_CHANGED`: the text changed since the client showed it (a save
 *   on Setup), so what the user confirmed is not what would be written. Nothing
 *   is written; the client reloads.
 * - A result above `MAX_EXTRA_CHARS` fails `E_SUGGESTION_TOO_LONG`, checked
 *   here so `saveRoleExtra` never answers `E_ROLE_EXTRA_INVALID`. Nothing is
 *   written or cut.
 *
 * Failures of the write itself keep the codes `roles.save-extra` answers with.
 * `saveRoleExtra` is synchronous and so is this check, so two calls do not
 * interleave between the comparison and the write.
 */
export function handleOrchestratorApplySuggestion(
  input: OrchestratorApplySuggestionInput,
  deps: OrchestratorRpcDeps = {},
): OrchestratorApplySuggestionOutput {
  let home: string | null;
  try {
    home = resolveDataHome(deps).home;
  } catch {
    home = null;
  }
  if (home === null) throw new DashboardError("E_DATA_HOME_UNAVAILABLE", `cannot save: ${unusableDataHomeMessage(deps)}`);

  const current = readRoleExtras(home)[input.role];
  if (extraHashOf(current) !== input.expectedHash) {
    throw new DashboardError(
      "E_ROLE_EXTRA_CHANGED",
      `the ${input.role}'s Additional instructions changed since they were shown; reload them and try again`,
    );
  }

  const next = appendSuggestion(current, input.text.trim());
  if (next.length > MAX_EXTRA_CHARS) {
    throw new DashboardError(
      "E_SUGGESTION_TOO_LONG",
      `adding this suggestion would make the ${input.role}'s Additional instructions ${next.length} characters, above the ${MAX_EXTRA_CHARS} allowed; nothing was added`,
    );
  }

  const extra = saveRoleExtra(home, input.role, next)[input.role];
  return {
    extra,
    full: fullInstructions(input.role, extra),
    chars: extra.length,
    maxChars: MAX_EXTRA_CHARS,
    hash: extraHashOf(extra),
  };
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

/** `server`, with every handler's Paseo handle handed to `onPaseo` first; a failing `onPaseo` never fails the call. */
function tapped(server: PluginServerContext, onPaseo: ((paseo: unknown) => void) | undefined): PluginServerContext {
  if (onPaseo === undefined) return server;
  const handle: PluginServerContext["handle"] = (contract, handler) =>
    server.handle(contract, (input, context) => {
      try {
        onPaseo(context?.paseo);
      } catch {
        // The watcher's handle never costs the user a call.
      }
      return handler(input, context);
    });
  return Object.assign(Object.create(server) as PluginServerContext, { handle });
}

export function registerOrchestratorRpcs(host: PluginServerContext, deps: OrchestratorRpcDeps = {}): void {
  const server = tapped(host, deps.onPaseo);
  server.handle(orchestratorApplySuggestionRpc, (input) => handleOrchestratorApplySuggestion(input, deps));
  // design §3.3: `orchestrator.open-preview` and `orchestrator.open` (orchestrator-agent.ts).
  registerOrchestratorAgentRpcs(server, deps);
  // design §8: state and set-autopilot (orchestrator-actions.ts).
  registerOrchestratorActionRpcs(server, deps);
}
