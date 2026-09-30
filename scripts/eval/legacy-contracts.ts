/**
 * The RPC shapes of builds before the autonomy programme's Phase 1, which the
 * evaluation still drives: the `0.4.1` channel measures the release the
 * programme started from, and `tree-autopilot` the tree before Phase 1
 * (design docs/design/paseo-bm-evaluation.md §6.3). The plugin itself retired
 * them (autonomy design §A.14) — the Inbox and the decision store replaced the
 * waiting list and the Orchestrator's proposals — so they live here, beside
 * the only code that still calls them, and are parsed by name over the
 * transport like every RPC the suite sends.
 *
 * Zod and plain values only.
 */
import { z } from "zod";
import { proposalSchema } from "../../plugin/shared/orchestrator.js";

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

/**
 * What the owner of the `tree-autopilot` channel reads from `orchestrator.state`
 * of those builds: the proposals waiting for Send, and the decisions the
 * Orchestrator asked. Both read as empty from a build that no longer sends them.
 */
export const legacyOrchestratorViewSchema = z.object({
  approvals: z.array(proposalSchema).default([]),
  decisions: z.array(proposalSchema).optional(),
});

/** `orchestrator.state`, read for the view above only. */
export const legacyOrchestratorStateRpc = { name: "orchestrator.state", output: legacyOrchestratorViewSchema } as const;
