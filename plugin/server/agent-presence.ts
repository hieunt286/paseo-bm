/**
 * Whether an agent can still be reached (ADR-042). Paseo closes the runtime of
 * an agent idle for an hour: its status reads `closed`, it keeps its session,
 * and a send resumes it. That is the daemon's housekeeping, not the owner's
 * decision (ADR-005 decision 5), so such an agent is `resting`, never `gone`.
 *
 * `gone` is what cannot take a message: no snapshot, an archived agent (a send
 * would un-archive it), or a closed agent with no session to resume. A snapshot
 * that does not carry the session reads `gone`, the answer from before ADR-042.
 */
export type AgentPresence = "live" | "resting" | "gone";

export interface PresenceSnapshot {
  status?: unknown;
  archivedAt?: unknown;
  persistence?: unknown;
}

function hasSession(persistence: unknown): boolean {
  if (persistence === null || typeof persistence !== "object") return false;
  const sessionId = (persistence as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.trim() !== "";
}

/** The presence of `agent`. Pure. */
export function presenceOf(agent: PresenceSnapshot | null | undefined): AgentPresence {
  if (agent === null || agent === undefined || (agent.archivedAt !== null && agent.archivedAt !== undefined && agent.archivedAt !== "")) return "gone";
  if (agent.status !== "closed") return "live";
  return hasSession(agent.persistence) ? "resting" : "gone";
}

/** True when `facts`, as `bmAgentsOf` reads them, can be reached: live or resting. Pure. */
export function isReachable(facts: { status: string; archived: boolean; resting?: boolean }): boolean {
  return !facts.archived && (facts.status !== "closed" || facts.resting === true);
}
