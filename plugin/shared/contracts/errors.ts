/**
 * The plugin's RPC error codes (`DASHBOARD_ERROR_CODES`) and `RpcError`, the
 * error an RPC handler throws with one.
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

// ---------------------------------------------------------------------------
// Error codes.
//
// Registered in the single product-wide registry (base design §4.4, delta
// `design-delta-20260916-trace-store`). They travel over the plugin RPC channel
// so they have no CLI exit code.
// ---------------------------------------------------------------------------

export const DASHBOARD_ERROR_CODES = [
  "E_BEADS_STORE_UNREADABLE",
  "E_TRACE_NOT_FOUND",
  "E_TRACE_STORE_UNWRITABLE",
  "E_TRACE_STORE_SCHEMA_TOO_NEW",
  "E_TRACE_REASSIGN_INVALID",
  "E_BEAD_NOT_FOUND",
  "E_TOOL_PRESENT",
  "E_TOOL_INSTALL_FAILED",
  // Delta 20260921 §4.3.3–§4.3.4 (ADR-008): the plugin's own writes of the role settings.
  "E_ROLE_SETTINGS_INVALID",
  "E_ROLE_SETTINGS_CONFLICT",
  "E_ROLE_SETTINGS_WRITE_FAILED",
  // Delta 20260921 §4.4.6: the fallback incident's actions (an f: decision's options).
  "E_FALLBACK_NOT_FOUND",
  "E_FALLBACK_NOT_PENDING",
  "E_FALLBACK_NO_CANDIDATE",
  "E_FALLBACK_NO_RESET",
  "E_FALLBACK_CREATE_FAILED",
  // 0.4.0 single source (ADR-012): the plugin owns its data folder, so every
  // store can now fail for the one reason the installer used to rule out.
  "E_DATA_HOME_UNAVAILABLE",
  // 0.4.0 (ADR-012 decision 4): the plugin creates the three roles itself.
  "E_SETUP_ROLES_FAILED",
  // 0.4.0 (ADR-012 decision 5): the machine-wide switches behind a warned button.
  "E_SETUP_WRITE_FAILED",
  "E_SKILLS_PRESENT",
  "E_SKILLS_INSTALL_FAILED",
  // Orchestrator design §8: a failed write of the Orchestrator's store
  // (`<data folder>/orchestrator/`).
  "E_ORCHESTRATOR_WRITE_FAILED",
  // Orchestrator design §3.3, §8: no `bm-orchestrator` profile, or its provider
  // is not available; nothing is created.
  "E_ORCHESTRATOR_UNAVAILABLE",
  // Autonomy design §A.4, §A.6 (ADR-017): the `decisions.*` RPCs — no such
  // decision; it is answered, superseded, withdrawn or expired; the answer is
  // not exactly one known option or the owner's words; an answer granting a
  // release, data, security or cost effect without its confirmation; `confirm`
  // on a decision that is not waiting for one; the store cannot be written.
  "E_DECISION_NOT_FOUND",
  "E_DECISION_SETTLED",
  "E_DECISION_ANSWER_INVALID",
  "E_DECISION_NOT_CONFIRMED",
  "E_DECISION_NOT_NEEDS_CONFIRMATION",
  "E_DECISION_WRITE_FAILED",
  // Autonomy design §G.7 (ADR-021): `coordination.set` — an unknown setting or
  // a value out of its bounds; the store cannot be written.
  "E_COORDINATION_INVALID",
  "E_COORDINATION_WRITE_FAILED",
  // Autonomy design §B.2, §B.9 (ADR-018): `autonomy.set` / `autonomy.reset` —
  // `delegate` for release, data, security or cost; `delegate` without the
  // owner's confirmation; an unknown project, class or mode; the policy store
  // cannot be written.
  "E_AUTONOMY_OWNER_ONLY",
  "E_AUTONOMY_NOT_CONFIRMED",
  "E_AUTONOMY_INVALID",
  "E_AUTONOMY_WRITE_FAILED",
  // Autonomy design §B.6, §B.9: the precedents — a save that is not a
  // precedent (bad scope, subject or text; a decision not answered by the
  // owner or without a subject); `precedents.end` of an unknown id; the store
  // cannot be written.
  "E_PRECEDENT_INVALID",
  "E_PRECEDENT_NOT_FOUND",
  "E_PRECEDENT_WRITE_FAILED",
  // Autonomy design §B.7, §B.9: the Inbox's Decided for you — `decisions.override`
  // on a decision the policy or a precedent did not answer for the owner; the
  // Inbox's last-opened time (`inbox/seen.json`) cannot be written.
  "E_DECISION_NOT_DELEGATED",
  "E_INBOX_WRITE_FAILED",
] as const;

export type DashboardErrorCode = (typeof DASHBOARD_ERROR_CODES)[number];

/**
 * Coded failure of a plugin RPC. The message starts with the code so it
 * survives transports that only forward `message`, exactly like
 * `ManagerEnsureError` does for `manager.ensure`.
 */
export class RpcError extends Error {
  readonly code: DashboardErrorCode;

  constructor(code: DashboardErrorCode, detail: string, options?: { cause?: unknown }) {
    super(`${code}: ${detail}`, options);
    // The name this error has always had in logs and tests; the rename to
    // `RpcError` is of the class only, so nothing a reader sees changes.
    this.name = "DashboardError";
    this.code = code;
  }
}

/** `RpcError` under the name its importers used before the contracts were split. */
export { RpcError as DashboardError };
