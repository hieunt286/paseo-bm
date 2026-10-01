import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { beadStatsSchema } from "./dashboard";
import { agentIdSchema, agentRoleSchema, workspaceIdSchema } from "./persisted";

/**
 * The chat cards and the Beads screen: the paseo-bm agents around a chat
 * (`chat.peers`), the beads of a workspace (`beads.*`) and the beads a chat
 * mentions (`chat.beads`).
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

/** One paseo-bm agent as a chat card needs it. */
export const chatPeerSchema = z.object({
  id: agentIdSchema,
  role: agentRoleSchema,
  title: z.string().nullable(),
  status: z.string(),
  parentId: z.string().nullable(),
  /** `bm.requestId` / `bm.batchId` labels. */
  requestId: z.string().nullable(),
  batchId: z.string().nullable(),
  /**
   * False when the agent has no `bm.role` label and was recognised by its
   * provider only (delta 20260918g §4.4). Defaults to true for older servers.
   */
  labelled: z.boolean().default(true),
  /** Archived in Paseo: never a recipient, since a message would bring it back (delta 20260918f F12). */
  archived: z.boolean(),
  /**
   * A fallback agent took over from this one (`bm.replacedBy`, or the agent of
   * a `switched` incident, delta 20260921 §4.4.8): never the request's Worker
   * again. Defaults to false for older servers.
   */
  replaced: z.boolean().default(false),
});

/**
 * `chat.peers` — the paseo-bm agent that owns a chat and the other paseo-bm
 * agents of its workspace (delta 20260916-chat-cards §4.3). Read-only.
 */
export const chatPeersRpc = defineRpc({
  name: "chat.peers",
  input: z.object({ agentId: agentIdSchema }),
  output: z.object({
    owner: chatPeerSchema.nullable(),
    peers: z.array(chatPeerSchema),
    /** The owner's workspace; null for an agent that is not paseo-bm's. */
    workspaceId: z.string().nullable(),
  }),
});

/** A Worker and the moment it did something to a bead. */
export const beadWorkMarkSchema = z.object({
  agentId: z.string().min(1),
  at: z.string(),
  /** The agent's title in Paseo; null when Paseo no longer lists the agent. */
  title: z.string().nullable(),
  /** The agent's status now (`running`, `idle`, …); null when it is gone. */
  status: z.string().nullable(),
});

/**
 * Who is working on an `in_progress` bead, from the trace store. `started` is
 * the Worker command that moved the bead to `in_progress`; `last` is the latest
 * Worker command or report that named the bead. Either can be unknown.
 */
export const beadWorkSchema = z.object({
  started: beadWorkMarkSchema.nullable(),
  last: beadWorkMarkSchema.nullable(),
});

/** One bead in the Beads screen list (delta 20260916-beads-screen). */
export const beadRowSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  status: z.string(),
  issueType: z.string(),
  /** 0 (highest) to 4; null when the store has none. */
  priority: z.number().int().nullable(),
  labels: z.array(z.string()),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  /** Derived like `br ready`: open, every blocker closed, not an epic. */
  ready: z.boolean(),
  parentId: z.string().nullable(),
  /** Only for `in_progress` beads; null when nothing was recorded. */
  work: beadWorkSchema.nullable(),
});

export const beadDetailSchema = beadRowSchema.extend({
  description: z.string().nullable(),
  closeReason: z.string().nullable(),
  blockedBy: z.array(z.string()),
  children: z.array(z.string()),
});

/** `beads.list` — every bead of a workspace, read from `.beads/issues.jsonl`. */
export const beadsListRpc = defineRpc({
  name: "beads.list",
  input: z.object({ workspaceId: workspaceIdSchema }),
  output: z.object({ beads: z.array(beadRowSchema), stats: beadStatsSchema }),
});

/** `beads.get` — one bead in full; an unknown id fails `E_BEAD_NOT_FOUND`. */
export const beadsGetRpc = defineRpc({
  name: "beads.get",
  input: z.object({ workspaceId: workspaceIdSchema, id: z.string().min(1) }),
  output: z.object({ bead: beadDetailSchema }),
});

export const beadActionSchema = z.enum(["implement", "delete", "close"]);

/**
 * `beads.action` — hands a bead to the workspace's Manager, which delegates it
 * to a Worker. The plugin itself never writes the bead store.
 */
export const beadsActionRpc = defineRpc({
  name: "beads.action",
  input: z.object({ workspaceId: workspaceIdSchema, id: z.string().min(1), action: beadActionSchema }),
  output: z.object({ managerId: z.string(), created: z.boolean() }),
});

/**
 * `chat.beads` — beads named in an agent's recent chat (messages and shell
 * commands), newest mention first. Read-only.
 */
export const chatBeadsRpc = defineRpc({
  name: "chat.beads",
  input: z.object({ workspaceId: workspaceIdSchema, agentId: agentIdSchema }),
  output: z.object({
    beads: z.array(z.object({ bead: beadRowSchema, mentions: z.number().int(), lastMentionedAt: z.string().nullable() })),
    scannedItems: z.number().int(),
  }),
});

export type BeadRow = z.infer<typeof beadRowSchema>;
/** Input shape: `labelled` may be absent (meaning labelled), as from a server older than delta 20260918g. */
export type ChatPeer = z.input<typeof chatPeerSchema>;
export type BeadWork = z.infer<typeof beadWorkSchema>;
export type BeadDetail = z.infer<typeof beadDetailSchema>;
export type BeadAction = z.infer<typeof beadActionSchema>;
