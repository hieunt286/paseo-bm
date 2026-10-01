/**
 * Ask back (change-014 outcome 3, ADR-025): the owner asks the asker of an
 * open decision a question from its card, and the asker replies; the decision
 * stays open. One thread per decision, stored beside the decision store
 * (`server/decision-thread-store.ts`), read by `decisions.thread` and the card.
 *
 * - Only a Worker's question (`q:`) or an Orchestrator's decision (`o:`) has
 *   an asker to ask (`askableKindOf`). A held request (`h:`) has none — its
 *   Worker is mid-call —, nor has a fallback incident (`f:`) or the owner's
 *   own override (`r:`).
 * - An entry is the owner's (`by: owner`) or the asker's (`by: asker`). On the
 *   owner's entry `agentId` is the asker the question was delivered to; on the
 *   asker's, the agent that replied, when known.
 * - An ask is open while the thread's last entry is the owner's: the asker
 *   replies once per ask (`hasOpenAsk`).
 * - An agent without the `bm_reply` tool replies in its own chat with a first
 *   line `BM-REPLY <decisionId>` (`replyLineOf`).
 *
 * Pure: Zod schemas and plain values only.
 */
import { z } from "zod";
import { decisionKindOf } from "./decisions";

/** The entries kept per decision: the newest. */
export const MAX_THREAD_ENTRIES = 20;
/** The longest text of one entry, after redaction. */
export const MAX_THREAD_TEXT_CHARS = 2000;

export const THREAD_AUTHORS = ["owner", "asker"] as const;
export const threadAuthorSchema = z.enum(THREAD_AUTHORS);
export type ThreadAuthor = z.infer<typeof threadAuthorSchema>;

export const threadEntrySchema = z.object({
  by: threadAuthorSchema,
  text: z.string().min(1).max(MAX_THREAD_TEXT_CHARS),
  at: z.string().min(1),
  /** The owner's entry: the asker it went to. The asker's: who replied, when known. */
  agentId: z.string().min(1).optional(),
});
export type ThreadEntry = z.infer<typeof threadEntrySchema>;

export const decisionThreadSchema = z.object({
  decisionId: z.string().min(1),
  entries: z.array(threadEntrySchema).max(MAX_THREAD_ENTRIES),
});
export type DecisionThread = z.infer<typeof decisionThreadSchema>;

/** The kinds of decision whose asker can be asked back. */
export type AskableKind = "question" | "orchestrator";

/** `question` for `q:`, `orchestrator` for `o:`, else null (held, fallback, override, not a decision id). */
export function askableKindOf(decisionId: string): AskableKind | null {
  const kind = decisionKindOf(decisionId);
  return kind === "question" || kind === "orchestrator" ? kind : null;
}

/** True while the owner's last question has no reply yet. */
export function hasOpenAsk(thread: Pick<DecisionThread, "entries">): boolean {
  return thread.entries.at(-1)?.by === "owner";
}

/** First word of an asker's plain-text reply, for an agent created before `bm_reply`. */
export const REPLY_LINE_MARKER = "BM-REPLY";

/**
 * The plain-text reply in `text`: a first line `BM-REPLY <decisionId>`,
 * optionally followed on that line by the start of the reply, then the reply.
 * Null when the text does not start so, names no askable decision, or holds
 * no reply.
 */
export function replyLineOf(text: unknown): { decisionId: string; text: string } | null {
  if (typeof text !== "string") return null;
  const match = /^[ \t]*BM-REPLY[ \t]+(\S+)[ \t]*(.*)(?:\r?\n([\s\S]*))?$/.exec(text);
  if (match === null) return null;
  const decisionId = match[1]!.replace(/^`|`$/g, "");
  if (askableKindOf(decisionId) === null) return null;
  const body = [match[2] ?? "", match[3] ?? ""].join("\n").trim();
  return body === "" ? null : { decisionId, text: body };
}
