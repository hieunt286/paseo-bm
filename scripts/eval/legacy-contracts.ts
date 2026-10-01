/**
 * The RPC shapes of the build before the autonomy programme's Phase 1 that the
 * evaluation still drives: the `0.4.1` channel measures the release the
 * programme started from (design docs/design/paseo-bm-evaluation.md §6.3).
 * The plugin itself retired them (autonomy design §A.14) — the Inbox and the
 * decision store replaced the waiting list — so they live here, beside the
 * only code that still calls them, and are parsed by name over the transport
 * like every RPC the suite sends. Nothing the tree before Phase 1 alone had
 * is kept: the suite measures only 0.4.1 and the tree.
 *
 * Zod and plain values only.
 */
import { z } from "zod";

/** The waiting list of those builds: one Worker waiting for the owner's answer in a Manager's chat. */
export const legacyWaitingWorkerSchema = z.object({
  managerId: z.string(),
  workspaceId: z.string(),
  workerId: z.string(),
  workerTitle: z.string().nullable(),
  requestId: z.string(),
  /** The report message as the Manager received it. */
  text: z.string(),
  at: z.string().nullable(),
  /** The report's questions already answered. */
  answered: z.array(z.string()).default([]),
});

export type LegacyWaitingWorker = z.infer<typeof legacyWaitingWorkerSchema>;

/** `chat.waiting` of those builds: the Workers waiting for the owner, read by the suite each poll. */
export const legacyChatWaitingRpc = {
  name: "chat.waiting",
  output: z.object({ waiting: z.array(legacyWaitingWorkerSchema) }),
} as const;
