/**
 * Whether a finished turn ended on a provider-plan failure, and which class
 * (delta 20260921 §4.4.4, REQ-065 a, b).
 *
 * Today the plugin ignores a failed turn (proposal M9): a Worker whose plan ran
 * out just stops. This module looks at one ended turn of an agent whose role
 * has a fallback chain (`FALLBACK_ROLES`) and no `bm.replacedBy` label, and
 * reads one of two signals:
 * - N1: the turn failed. The text is `outcome.error.message`.
 * - N2: the turn completed without doing anything: no tool call, no
 *   `BM-REPORT` or `BM-REVIEW` block in the agent's own messages (REQ-065 a:
 *   a turn "without a BM-REPORT"; a Reviewer's verdict that woke a Worker is
 *   not the Worker's report), a last assistant message of at most 500
 *   characters, and either no output tokens or, when the provider reports no
 *   tokens, a turn that was not started by one of the plugin's notices. The
 *   text is that last message (proposal S3). The notice rule keeps a Manager's
 *   one-line answer to a `BM-FALLBACK` from reading as a failure of its own.
 * The text is then classified (`shared/fallback-patterns.ts`); L3 and L6 mean
 * nothing is done, as before.
 *
 * Where each fact comes from:
 * - The turn's items: the hook payload, cut at its last user message
 *   (`sliceLastTurn`), as `format-check.ts` reads it. The refetch entries are
 *   not filtered by `turnId` here because Paseo reuses turn ids inside one
 *   agent (AGENTS.md), so an older turn with the same id could add its tool
 *   calls.
 * - Labels and output tokens: the agent snapshot of one `timeline.refetch`,
 *   the same call the collector makes; `timestampsForTurn` turns it into
 *   `usage`, so "0 output tokens" means exactly what a trace record says.
 *
 * Checks run cheapest first, so a turn with a tool call, or whose text does not
 * classify as a fallback class, costs no daemon call. Nothing here records an
 * incident or reads `role-fallback.json`: the caller hands the file's
 * `patterns` in. Never throws: a failure costs one `[paseo-bm]` log line and
 * the turn is not classified.
 */
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { FALLBACK_ROLES } from "../shared/fallback";
import { compilePatterns, isFallbackClass, matchClass, type FallbackClass, type UserPatterns } from "../shared/fallback-patterns";
import { roleOfAgent, roleOfProvider } from "./agent-role";
import { parseReports, parseReviews } from "./bm-report";
import { REFETCH_LIMIT, sliceLastTurn, timestampsForTurn, type CollectorPaseo } from "./collector";
import { isPluginNotice } from "./notices";
import type { Usage } from "../shared/contracts";

type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];

/** Label the plugin puts on an agent once a fallback agent took over from it (§4.4.7). */
export const REPLACED_BY_LABEL = "bm.replacedBy";

/** Longest last assistant message an N2 turn may end on. */
export const MAX_QUIET_REPLY_CHARS = 500;

/** A turn that ended on a provider-plan failure. */
export interface FallbackSignal {
  class: FallbackClass;
  /** N1 (`failed`) or N2 (`completed`). */
  signal: "failed" | "completed";
  /** The text that was classified, trimmed; not cut, not redacted. */
  message: string;
}

export interface FallbackDetectDeps {
  /** Reads the agent's labels and usage; `PaseoApi` is structurally assignable. */
  paseo: CollectorPaseo;
  /** The `patterns` of `role-fallback.json`, read by the caller; absent means the defaults of every class. */
  patterns?: UserPatterns | null;
  log?: (message: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFallbackRole(role: unknown): boolean {
  return (FALLBACK_ROLES as readonly unknown[]).includes(role);
}

function textItem(item: unknown): { type: string; text: string } | null {
  if (item === null || typeof item !== "object") return null;
  const { type, text } = item as { type?: unknown; text?: unknown };
  if ((type !== "user_message" && type !== "assistant_message") || typeof text !== "string") return null;
  return { type, text };
}

/** True when a message carries a `BM-REPORT` or `BM-REVIEW` block, read the way the collector reads them. */
function hasBlock(text: string): boolean {
  const context = { agentId: "", at: "" };
  return parseReports(text, context).length > 0 || parseReviews(text, context).length > 0;
}

/**
 * The last assistant message of a turn that did nothing else (N2 conditions
 * 1 to 3), trimmed, or null: the turn has a tool call, an assistant message
 * with a block, no assistant message, or a last one that is empty or longer
 * than `MAX_QUIET_REPLY_CHARS`. A block in a message the agent RECEIVED does
 * not count: a Worker woken by its Reviewer's `BM-REVIEW` can still hit its limit.
 */
export function quietReply(items: readonly unknown[]): string | null {
  let last: string | null = null;
  for (const item of items) {
    if ((item as { type?: unknown } | null)?.type === "tool_call") return null;
    const message = textItem(item);
    if (message === null || message.type !== "assistant_message") continue;
    if (hasBlock(message.text)) return null;
    last = message.text;
  }
  const reply = last?.trim() ?? "";
  return reply !== "" && reply.length <= MAX_QUIET_REPLY_CHARS ? reply : null;
}

/**
 * N2 condition 4: the turn produced no output tokens, or, when the provider
 * reports none (`usage` null), the message that started it is not one of the
 * plugin's notices. A turn with no user message counts as not started by one.
 */
export function quietTokens(usage: Usage | null, items: readonly unknown[]): boolean {
  if (usage !== null) return usage.outputTokens === 0;
  const first = items.length > 0 ? textItem(items[0]) : null;
  return !isPluginNotice(first?.type === "user_message" ? first.text : null);
}

/**
 * The agent's labels and usage from one `timeline.refetch`. The payload is
 * handed to the collector's own reader so the usage is read exactly as a trace
 * record's. Throws when the call fails or the payload carries no snapshot.
 */
async function readAgent(
  paseo: CollectorPaseo,
  agentId: string,
  turnId: string | null,
): Promise<{ labels: Record<string, unknown>; usage: Usage | null }> {
  const payload = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: REFETCH_LIMIT });
  const snapshot = (payload as { agent?: unknown } | null)?.agent;
  if (snapshot === null || typeof snapshot !== "object") throw new Error("the timeline refetch returned no agent snapshot");
  const replay: CollectorPaseo = { agents: { ref: () => ({ timeline: { refetch: async () => payload } }) } };
  const { usage } = await timestampsForTurn({ location: null, paseo: replay }, agentId, turnId);
  const labels = (snapshot as { labels?: unknown }).labels;
  return { labels: labels !== null && typeof labels === "object" ? (labels as Record<string, unknown>) : {}, usage };
}

/**
 * Classifies one ended turn. Returns the class, the signal and the text when
 * the turn ended on an L1, L2, L4 or L5 failure; null otherwise, including
 * for a canceled turn, an agent outside `FALLBACK_ROLES`, an agent already
 * replaced, and any failure (logged once).
 *
 * The event carries no labels, so the provider filters first: an agent whose
 * provider is not a paseo-bm alias of a fallback role is never fetched. The
 * snapshot's labels then decide as `roleOfAgent` does, the `bm.role` label
 * winning over the provider.
 */
export async function classifyTurn(event: TurnEndedEvent, deps: FallbackDetectDeps): Promise<FallbackSignal | null> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  let agentId = "(unknown)";
  try {
    const agent = event.agent;
    agentId = typeof agent?.id === "string" ? agent.id : agentId;
    const outcome = event.outcome;
    if (outcome?.kind !== "failed" && outcome?.kind !== "completed") return null;
    if (!isFallbackRole(roleOfProvider(agent.provider))) return null;

    const items = sliceLastTurn(Array.isArray(event.timeline) ? event.timeline : []);
    const message =
      outcome.kind === "failed"
        ? typeof outcome.error?.message === "string"
          ? outcome.error.message.trim()
          : ""
        : quietReply(items);
    if (message === null || message === "") return null;
    const found = matchClass(message, compilePatterns(deps.patterns, log));
    if (!isFallbackClass(found)) return null;

    const { labels, usage } = await readAgent(deps.paseo, agent.id, event.turnId);
    if (!isFallbackRole(roleOfAgent({ provider: agent.provider, labels })?.role)) return null;
    if (Object.prototype.hasOwnProperty.call(labels, REPLACED_BY_LABEL)) return null;
    if (outcome.kind === "completed" && !quietTokens(usage, items)) return null;
    return { class: found, signal: outcome.kind, message };
  } catch (error) {
    log(`[paseo-bm] fallback detection skipped a turn of agent ${agentId}: ${describeError(error)}`);
    return null;
  }
}
