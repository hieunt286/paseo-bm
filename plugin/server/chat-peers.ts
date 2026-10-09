/**
 * The paseo-bm agents of a workspace as chat peers, shared by `chat.peers`
 * (`chat-rpc.ts`) and a Manager's fallback handover (`fallback-handover.ts`),
 * so a chat card and a handover see the same Workers (delta 20260918f §4.9).
 */
import type { ChatPeer, TraceRecord } from "../shared/contracts";
import { requireLocation } from "./dashboard-rpc";
import { missionManagerOf } from "./mission-roster";
import { dataHome } from "./rpc-kit";
import type { DashboardPaseo } from "./paseo-directory";
import { readRecords } from "./trace-store";
import { requestIdOfAgent, type AgentFacts } from "./traces";

/**
 * The paseo-bm agents of one workspace as chat peers, archived ones included
 * and flagged. Agents created before the `bm.requestId` label existed carry
 * none; their request is read from what they wrote, the same way the request
 * history does — the trace store is read at most once, and only when such an
 * agent is there (delta 20260918f §4.9). A Worker of a mission's request has
 * its current Main as parent, and that Main, which lives in the Missions home,
 * is a peer too (missions design §6).
 */
export async function peersOfWorkspace(
  all: ReadonlyArray<{ facts: AgentFacts; workspaceId: string | null }>,
  workspaceId: string,
  readWorkspaceRecords: () => Promise<TraceRecord[]>,
  /** Agent id → its replacement, from `switched` fallback incidents (delta 20260921 §4.4.8). */
  replacements: ReadonlyMap<string, string> = new Map(),
  /** The data folder, whose request registry names a mission request's Main; looked up by default. */
  home: string | null = dataHome(),
): Promise<ChatPeer[]> {
  let records: TraceRecord[] | null = null;
  const peers: ChatPeer[] = [];
  const peerOf = (facts: AgentFacts, requestId: string | null, parentId: string | null): ChatPeer => ({
    id: facts.id,
    role: facts.role,
    title: facts.title ?? null,
    status: facts.status,
    parentId,
    requestId,
    batchId: facts.batchIdLabel,
    labelled: facts.labelled ?? true,
    archived: facts.archived,
    replaced: (facts.replacedBy ?? null) !== null || replacements.has(facts.id),
  });
  const mains = new Set<string>();
  for (const { facts } of all.filter((entry) => entry.workspaceId === workspaceId)) {
    let requestId = facts.requestIdLabel;
    if (requestId === null && facts.role !== "manager") {
      records ??= await readWorkspaceRecords();
      requestId = requestIdOfAgent(facts, records).requestId;
    }
    // Missions design §3.4 step 4: a Worker of a mission's request is its current Main's (the registry's).
    const main = facts.role === "worker" ? missionManagerOf(home, requestId) : null;
    if (main !== null) mains.add(main);
    peers.push(peerOf(facts, requestId, main ?? facts.parentAgentId));
  }
  // Missions design §6: a Worker's Main lives in the Missions home and is still a peer of its chat.
  for (const { facts } of all) {
    if (mains.has(facts.id) && !peers.some((peer) => peer.id === facts.id)) peers.push(peerOf(facts, null, facts.parentAgentId));
  }
  return peers;
}

/** The trace records of one workspace, or none when the store cannot be read. */
export function workspaceRecordsReader(
  paseo: DashboardPaseo,
  workspaceId: string,
  deps: { homedir?: () => string } = {},
): () => Promise<TraceRecord[]> {
  return async () => {
    try {
      return readRecords(await requireLocation(paseo, deps), workspaceId).records;
    } catch {
      // Without a trace store only the labels are known.
      return [];
    }
  };
}
