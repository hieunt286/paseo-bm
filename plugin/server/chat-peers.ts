/**
 * The paseo-bm agents of a workspace as chat peers, shared by `chat.peers`
 * (`chat-rpc.ts`) and `chat.waiting` (`chat-waiting.ts`) so a chat card and a
 * waiting pill see the same Workers (delta 20260918f §4.9). A module of its own
 * so neither handler imports the other.
 */
import type { ChatPeer, TraceRecord } from "../shared/contracts";
import { requireLocation, type DashboardPaseo } from "./dashboard-rpc";
import { readRecords } from "./trace-store";
import { requestIdOfAgent, type AgentFacts } from "./traces";

/**
 * The paseo-bm agents of one workspace as chat peers, archived ones included
 * and flagged. Agents created before the `bm.requestId` label existed carry
 * none; their request is read from what they wrote, the same way the Metric
 * screen does — the trace store is read at most once, and only when such an
 * agent is there (delta 20260918f §4.9). `chat.peers` and `chat.waiting` both
 * use it, so a chat card and a waiting pill see the same Workers.
 */
export async function peersOfWorkspace(
  all: ReadonlyArray<{ facts: AgentFacts; workspaceId: string | null }>,
  workspaceId: string,
  readWorkspaceRecords: () => Promise<TraceRecord[]>,
): Promise<ChatPeer[]> {
  let records: TraceRecord[] | null = null;
  const peers: ChatPeer[] = [];
  for (const { facts } of all.filter((entry) => entry.workspaceId === workspaceId)) {
    let requestId = facts.requestIdLabel;
    if (requestId === null && facts.role !== "manager") {
      records ??= await readWorkspaceRecords();
      requestId = requestIdOfAgent(facts, records).requestId;
    }
    peers.push({
      id: facts.id,
      role: facts.role,
      title: facts.title ?? null,
      status: facts.status,
      parentId: facts.parentAgentId,
      requestId,
      batchId: facts.batchIdLabel,
      labelled: facts.labelled ?? true,
      archived: facts.archived,
    });
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
