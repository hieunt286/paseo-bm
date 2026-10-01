/**
 * Calls that were denied and never ran (Phase 4 live check 2026-10-01, F3 and
 * F5): the Worker watch's `danger` signal and the replay's A-6 count only
 * effectful actions that ran, so a call the owner or the action boundary
 * denied must not count as one.
 *
 * Two ways to tell, from what the timeline and the trace store keep:
 *
 * - **Codex.** Paseo answers a denied Codex call with a timeline `tool_call`
 *   of its own, `status: "failed"`, `metadata.denied: true`, whose `callId` is
 *   the permission request id, `permission-<the call's item id>` (Paseo 0.9.2
 *   `emitDeniedToolCallTimelineEvent`). The call's own item (`exec-…`) stays
 *   `running`: one call, two entries, neither of which ran.
 * - **Claude.** Its denied call keeps its own `callId` (`toolu_…`) and ends
 *   `failed`, like a command that ran and failed. What tells them apart is the
 *   held decision (`h:`) of that Worker that was denied or withdrawn, whose
 *   question quotes that command, asked around when the call was made.
 *
 * Pure: no Node and no React Native imports.
 */
import { decisionKindOf, type Decision } from "./decisions";
import { timeOrNull } from "./time";

/** The prefix of Paseo's permission request ids, and of the `callId` of its denial entry for a Codex call. */
export const PERMISSION_CALL_PREFIX = "permission-";

/** How far a denied call's timeline time may lie outside its held decision's asked–settled span. */
export const DENIED_CALL_SLACK_MS = 60_000;

/**
 * The call a Codex denial entry stands for: `exec-X` for `permission-exec-X`;
 * null for any other id.
 */
export function deniedTwinOf(callId: string | null | undefined): string | null {
  if (typeof callId !== "string" || !callId.startsWith(PERMISSION_CALL_PREFIX)) return null;
  const twin = callId.slice(PERMISSION_CALL_PREFIX.length);
  return twin === "" ? null : twin;
}

/** A held request that was denied or withdrawn: whose, which command, and when it was open. */
export interface DeniedHeldCall {
  agentId: string;
  /** The command as the question quotes it: masked, its white space collapsed. */
  command: string;
  /** True when the question cut the command short (it ends with `…`): compared as a prefix. */
  cut: boolean;
  from: number;
  to: number;
}

/** The whitespace-collapsed form both sides are compared in. */
export function collapsedCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/** The quoted command of a held shell request's question (`… asks to run `<command>`. Held: …`), or null. */
function quotedCommandOf(question: string): string | null {
  const match = /^The (?:Worker|Reviewer) asks to run `([\s\S]*)`\.(?: Held: |$)/.exec(question);
  return match === null || match[1]!.trim() === "" ? null : match[1]!;
}

/**
 * The held shell requests that did not run: `h:` decisions answered Deny, or
 * withdrawn or expired (a deny in Paseo's prompt, an interrupted turn).
 */
export function deniedHeldCallsOf(decisions: readonly Decision[]): DeniedHeldCall[] {
  const out: DeniedHeldCall[] = [];
  for (const decision of decisions) {
    if (decisionKindOf(decision.id) !== "held") continue;
    const denied =
      (decision.status === "answered" && decision.answer?.optionKey === "deny") || decision.status === "withdrawn" || decision.status === "expired";
    if (!denied) continue;
    const quoted = quotedCommandOf(decision.question);
    const from = timeOrNull(decision.askedAt);
    const to = timeOrNull(decision.settledAt ?? decision.answer?.at ?? null) ?? from;
    if (quoted === null || from === null || to === null) continue;
    const cut = quoted.endsWith("…");
    out.push({ agentId: decision.askedBy.agentId ?? "", command: collapsedCommand(cut ? quoted.slice(0, -1) : quoted), cut, from, to });
  }
  return out;
}

/**
 * True when a `failed` shell call of `agentId` at `at` is one of the denied
 * held requests: the same (masked) command, at a time within their span.
 */
export function isDeniedHeldCall(denied: readonly DeniedHeldCall[], agentId: string | null, command: string, at: string | null): boolean {
  const time = timeOrNull(at);
  if (agentId === null || time === null || denied.length === 0) return false;
  const shown = collapsedCommand(command);
  return denied.some(
    (entry) =>
      entry.agentId === agentId &&
      time >= entry.from - DENIED_CALL_SLACK_MS &&
      time <= entry.to + DENIED_CALL_SLACK_MS &&
      (entry.cut ? shown.startsWith(entry.command) : shown === entry.command),
  );
}
