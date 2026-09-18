/**
 * `chat.waiting`: which Workers wait for the user's answer, per Manager
 * (delta 20260918d-card-replies §4.8, REQ-059 j). Read-only.
 *
 * The source is each Manager's live timeline, not the trace store: a report
 * reaches the store only when the Manager's turn ends, and the pill should
 * appear as soon as the question does.
 */
import { parseQuestions } from "../shared/bm-questions";
import { parseReports } from "../shared/bm-report";
import type { TraceRecord, WaitingWorker } from "../shared/contracts";
import { bmAgentsOf, requireLocation, type DashboardPaseo } from "./dashboard-rpc";
import { readTimelinePages } from "./live-timeline";
import { readRecords } from "./trace-store";
import { requestIdOfAgent } from "./traces";

/** How much of a Manager's timeline is read per call: one page, newest first. */
export const WAITING_TIMELINE_PAGES = 1;
export const WAITING_TIMELINE_LIMIT = 200;

const REQUEST_ID = /^req-\d{8}T\d{6}Z$/;

/** A timeline entry as Paseo returns it. */
export interface WaitingEntry {
  item?: unknown;
  timestamp?: unknown;
}

/** A Worker as `waitingOf` needs it. */
export interface WaitingCandidate {
  id: string;
  workspaceId: string | null;
  title: string | null;
  status: string;
  requestId: string | null;
}

/**
 * The Workers waiting on one Manager. `entries` are that Manager's timeline,
 * NEWEST FIRST. A message counts only when another agent sent it (no
 * `clientMessageId`); the newest report of each request decides, so a later
 * `received` or `finished` hides an earlier `blocked`. A Worker is waiting
 * when that newest report is `blocked` with at least one question for its own
 * request, and the single Worker of that request is idle (or errored): a
 * running Worker already has its answer.
 */
export function waitingOf(
  manager: { id: string; workspaceId: string },
  entries: readonly WaitingEntry[],
  workers: readonly WaitingCandidate[],
): WaitingWorker[] {
  const newest = new Map<string, { phase: string | null; text: string; at: string | null }>();
  for (const entry of entries) {
    const item = entry.item as { type?: unknown; text?: unknown; clientMessageId?: unknown } | null | undefined;
    if (item === null || item === undefined || item.type !== "user_message") continue;
    if (typeof item.clientMessageId === "string" || typeof item.text !== "string") continue;
    const at = typeof entry.timestamp === "string" ? entry.timestamp : null;
    const report = parseReports(item.text, { agentId: manager.id, at: at ?? "" })
      .filter((block) => block.requestId !== null && REQUEST_ID.test(block.requestId))
      .at(-1);
    if (report === undefined || newest.has(report.requestId!)) continue;
    newest.set(report.requestId!, { phase: report.phase, text: item.text, at });
  }

  const out: WaitingWorker[] = [];
  for (const [requestId, report] of newest) {
    if (report.phase !== "blocked") continue;
    const asked = parseQuestions(report.text);
    if (asked === null || asked.questions.length === 0) continue;
    if (asked.requestId !== null && asked.requestId !== requestId) continue;
    const matches = workers.filter((worker) => worker.workspaceId === manager.workspaceId && worker.requestId === requestId);
    if (matches.length !== 1) continue;
    const worker = matches[0]!;
    if (worker.status !== "idle" && worker.status !== "error") continue;
    out.push({
      managerId: manager.id,
      workspaceId: manager.workspaceId,
      workerId: worker.id,
      workerTitle: worker.title,
      requestId,
      text: report.text,
      at: report.at,
    });
  }
  return out;
}

/** `chat.waiting` handler: every live Manager's waiting Workers. Never throws for one Manager. */
export async function handleChatWaiting(
  paseo: DashboardPaseo,
  deps: { homedir?: () => string } = {},
): Promise<{ waiting: WaitingWorker[] }> {
  const all = await bmAgentsOf(paseo);
  const managers = all.filter(
    (entry) => entry.facts.role === "manager" && !entry.facts.archived && entry.facts.status !== "closed" && entry.workspaceId !== null,
  );
  if (managers.length === 0) return { waiting: [] };

  // Workers made before the `bm.requestId` label existed carry none; their
  // request is read from what they wrote, as `chat.peers` does.
  const recordsOf = new Map<string, TraceRecord[]>();
  const records = async (workspaceId: string): Promise<TraceRecord[]> => {
    const known = recordsOf.get(workspaceId);
    if (known !== undefined) return known;
    let read: TraceRecord[] = [];
    try {
      read = readRecords(await requireLocation(paseo, deps), workspaceId).records;
    } catch {
      // Without a trace store only the labels are known.
    }
    recordsOf.set(workspaceId, read);
    return read;
  };
  const workers: WaitingCandidate[] = [];
  for (const entry of all) {
    if (entry.facts.role !== "worker" || entry.facts.archived) continue;
    const requestId =
      entry.facts.requestIdLabel ??
      (entry.workspaceId === null ? null : requestIdOfAgent(entry.facts, await records(entry.workspaceId)).requestId);
    workers.push({ id: entry.facts.id, workspaceId: entry.workspaceId, title: entry.facts.title ?? null, status: entry.facts.status, requestId });
  }

  const waiting: WaitingWorker[] = [];
  for (const manager of managers) {
    const entries: WaitingEntry[] = [];
    try {
      await readTimelinePages(paseo, manager.facts.id, { pages: WAITING_TIMELINE_PAGES, limit: WAITING_TIMELINE_LIMIT }, (page) => {
        // Pages come oldest first; `waitingOf` wants newest first.
        entries.push(...[...page].reverse());
      });
    } catch {
      continue;
    }
    waiting.push(...waitingOf({ id: manager.facts.id, workspaceId: manager.workspaceId! }, entries, workers));
  }
  return { waiting };
}
