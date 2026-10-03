/**
 * Who a `user_message` comes from (design §16.2, ADR-027 decision 5): the one
 * rule set every module that reads a chat uses — the collector, the
 * Orchestrator's owner-word check, the handover, the live timeline,
 * `bm_agent_messages`, the format check and the chat cards.
 *
 * Called only for a `user_message`; an `assistant_message` is its agent's own.
 * The rules apply in order:
 *
 * 1. The text starts with a notice marker (`isPluginNotice`), or the plugin's
 *    send log says the plugin sent it (`opts.pluginSent`: the `/compact` of a
 *    compaction, `server/compaction-store.ts`) → `plugin-notice`. The log is
 *    consulted only for a message that carries `clientMessageId`, as every
 *    message the plugin sends does.
 * 2. The text starts with a prompt marker (`isPluginPrompt`: `BM-BRIEF`, and
 *    the legacy `BM-HANDOVER`, `BM-HANDOFF-BRIEF` and the Orchestrator's old
 *    first words) → `plugin-prompt`.
 * 3. No `clientMessageId` → `agent`: another agent sent it with
 *    `send_agent_prompt` (AGENTS.md).
 * 4. Otherwise → `owner`: typed in the app, `BM-NEW-REQUEST` included, and
 *    what the plugin sends on the owner's click (`server/bead-actions.ts`).
 *
 * Markers come before `clientMessageId`, so a marker never gives a message the
 * owner's origin, whoever wrote it — and neither plugin origin carries
 * authority: that is checked in code. Known limit: an owner who types a
 * message starting with a marker is read as the plugin.
 *
 * Pure, with no Node API: the client's card parser imports the same rules.
 */
import { isPluginNotice, isPluginPrompt } from "./notices";

export type MessageOrigin = "owner" | "plugin-notice" | "plugin-prompt" | "agent";

export interface OriginOptions {
  /** Whether the plugin's send log holds this text (the compaction's `/compact`). */
  pluginSent?: (text: string) => boolean;
}

export function originOf(message: { text: string; clientMessageId?: unknown }, opts: OriginOptions = {}): MessageOrigin {
  const { text } = message;
  if (isPluginNotice(text)) return "plugin-notice";
  if (isPluginPrompt(text)) return "plugin-prompt";
  if (typeof message.clientMessageId !== "string") return "agent";
  // The send log is read last, for a message that would otherwise be the
  // owner's: what the plugin sends always carries `clientMessageId`, so the
  // result is the same, and a relayed message never costs a lookup.
  if (opts.pluginSent?.(text) === true) return "plugin-notice";
  return "owner";
}

/** Either plugin origin: a notice or a first prompt. */
export function isPluginOrigin(origin: MessageOrigin): boolean {
  return origin === "plugin-notice" || origin === "plugin-prompt";
}
