/**
 * RPCs behind the chat cards and the "Beads in this chat" panel
 * (deltas 20260916-chat-cards §4.3 and §7). All read-only.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { beadRowOf } from "./bead-actions";
import { readBeads } from "./beads-store";
import { bmAgentsOf, requireLocation, workspaceDirectory, type DashboardPaseo } from "./dashboard-rpc";
import { readTimelinePages } from "./live-timeline";
import { handleChatWaiting } from "./chat-waiting";
import { readRecords } from "./trace-store";
import { requestIdOfAgent, type AgentFacts } from "./traces";
import { beadIdCandidates } from "../shared/bead-ids";
import {
  beadsLookupRpc,
  chatBeadsRpc,
  chatPeersRpc,
  chatWaitingRpc,
  type BeadRow,
  type ChatPeer,
  type TraceRecord,
} from "../shared/contracts";

/**
 * `chat.peers` handler: the paseo-bm agent that owns a chat and the other
 * paseo-bm agents of its workspace, so a chat card can say who a message came
 * from and where a reply goes. Read-only; an agent that is not paseo-bm's gets
 * no owner and no peers.
 */
export async function handleChatPeers(
  input: { agentId: string },
  paseo: DashboardPaseo,
  deps: { homedir?: () => string } = {},
): Promise<{ owner: ChatPeer | null; peers: ChatPeer[]; workspaceId: string | null }> {
  const all = await bmAgentsOf(paseo);
  const owner = all.find((entry) => entry.facts.id === input.agentId);
  if (owner === undefined || owner.workspaceId === null) return { owner: null, peers: [], workspaceId: null };
  // Agents created before the `bm.requestId` label existed carry none; their
  // request is read from what they wrote, the same way the Metric screen does.
  let records: TraceRecord[] = [];
  try {
    records = readRecords(await requireLocation(paseo, deps), owner.workspaceId).records;
  } catch {
    // Without a trace store only the labels are known.
  }
  const peerOf = ({ facts }: { facts: AgentFacts }): ChatPeer => ({
    id: facts.id,
    role: facts.role,
    title: facts.title ?? null,
    status: facts.status,
    parentId: facts.parentAgentId,
    requestId: facts.requestIdLabel ?? (facts.role === "manager" ? null : requestIdOfAgent(facts, records).requestId),
    batchId: facts.batchIdLabel,
    labelled: facts.labelled ?? true,
  });
  return {
    owner: peerOf(owner),
    peers: all.filter((entry) => entry.workspaceId === owner.workspaceId && entry.facts.id !== input.agentId).map(peerOf),
    workspaceId: owner.workspaceId,
  };
}

/** `beads.lookup` handler: the listed ids the bead store has, in the order asked. Read-only. */
export async function handleBeadsLookup(
  input: { workspaceId: string; ids: readonly string[] },
  paseo: DashboardPaseo,
): Promise<{ beads: BeadRow[] }> {
  const directory = await workspaceDirectory(paseo, input.workspaceId);
  if (directory === null) return { beads: [] };
  const { beads } = readBeads(directory);
  return {
    beads: [...new Set(input.ids)].flatMap((id) => {
      const bead = beads.get(id);
      return bead === undefined ? [] : [beadRowOf(bead, beads)];
    }),
  };
}

/** How far back `chat.beads` reads an agent's timeline. */
export const CHAT_BEADS_PAGES = 2;
export const CHAT_BEADS_PAGE_SIZE = 200;
export const CHAT_BEADS_LIMIT = 30;

/** Text of a timeline item that can name a bead: messages, and shell commands. */
function textsOfItem(item: unknown): string[] {
  const entry = item as { type?: unknown; text?: unknown; detail?: { type?: unknown; command?: unknown } } | null;
  if (entry === null || typeof entry !== "object") return [];
  if ((entry.type === "user_message" || entry.type === "assistant_message") && typeof entry.text === "string") return [entry.text];
  if (entry.type === "tool_call" && entry.detail?.type === "shell" && typeof entry.detail.command === "string") return [entry.detail.command];
  return [];
}

/**
 * `chat.beads` handler: beads named in an agent's recent timeline, newest
 * mention first, so the chat panel can show what the conversation is about.
 */
export async function handleChatBeads(
  input: { workspaceId: string; agentId: string },
  paseo: DashboardPaseo,
): Promise<{ beads: Array<{ bead: BeadRow; mentions: number; lastMentionedAt: string | null }>; scannedItems: number }> {
  const directory = await workspaceDirectory(paseo, input.workspaceId);
  if (directory === null) return { beads: [], scannedItems: 0 };
  const { beads } = readBeads(directory);
  // Insertion order is newest mention first.
  const seen = new Map<string, { mentions: number; last: string | null }>();
  const scanned = await readTimelinePages(paseo, input.agentId, { pages: CHAT_BEADS_PAGES, limit: CHAT_BEADS_PAGE_SIZE }, (entries) => {
    // Newest first, so the first time an id is seen is its latest mention.
    for (const entry of [...entries].reverse()) {
      const at = typeof entry.timestamp === "string" ? entry.timestamp : null;
      for (const text of textsOfItem(entry.item)) {
        for (const id of beadIdCandidates(text)) {
          if (!beads.has(id)) continue;
          const current = seen.get(id);
          if (current === undefined) seen.set(id, { mentions: 1, last: at });
          else current.mentions += 1;
        }
      }
    }
  });
  return {
    beads: [...seen.entries()]
      .slice(0, CHAT_BEADS_LIMIT)
      .map(([id, mark]) => ({ bead: beadRowOf(beads.get(id)!, beads), mentions: mark.mentions, lastMentionedAt: mark.last })),
    scannedItems: scanned,
  };
}

/** Registers the chat RPCs. Kept apart from the Dashboard's to avoid an import cycle. */
export function registerChatRpcs(server: PluginServerContext): void {
  const sdk = (context: { paseo: unknown }) => context.paseo as DashboardPaseo;
  server.handle(chatPeersRpc, (input, context) => handleChatPeers(input, sdk(context)));
  server.handle(beadsLookupRpc, (input, context) => handleBeadsLookup(input, sdk(context)));
  server.handle(chatBeadsRpc, (input, context) => handleChatBeads(input, sdk(context)));
  server.handle(chatWaitingRpc, (_input, context) => handleChatWaiting(sdk(context)));
}
