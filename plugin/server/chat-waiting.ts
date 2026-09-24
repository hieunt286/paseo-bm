/**
 * `chat.waiting`: which Workers wait for the user's answer, per Manager
 * (delta 20260918d-card-replies §4.8, REQ-059 j), and which fallback
 * incidents wait for the user's decision (delta 20260921 §4.4.6). Read-only.
 *
 * The Workers come from each Manager's live timeline, not the trace store: a
 * report reaches the store only when the Manager's turn ends, and the pill
 * should appear as soon as the question does. The incidents come from the
 * incidents file, not the timeline, so their pill is right even when the
 * Manager's own turn failed on the same plan.
 */
import { join } from "node:path";
import { parseQuestions } from "../shared/bm-questions";
import { parseReports } from "../shared/bm-report";
import type { FallbackIncident, WaitingFallback, WaitingWorker } from "../shared/contracts";
import { soleWorkerOf } from "../shared/sole-worker";
import { peersOfWorkspace, workspaceRecordsReader } from "./chat-peers";
import { bmAgentsOf, type DashboardPaseo } from "./dashboard-rpc";
import { readIncidents, replacementsOf } from "./fallback-state";
import { readTimelinePages } from "./live-timeline";
import { answeredIds, readQaLedgerSafely } from "./qa-ledger";
import { TRACES_DIR_NAME } from "./install-home";
import { installHomeOf } from "./role-extras";
import { TIMED_OUT, withTimeout } from "./role-mode";

/** How much of a Manager's timeline is read per call: one page, newest first. */
export const WAITING_TIMELINE_PAGES = 1;
export const WAITING_TIMELINE_LIMIT = 200;

const REQUEST_ID = /^req-\d{8}T\d{6}Z$/;
const NONE_ANSWERED: ReadonlySet<string> = new Set();

/** A timeline entry as Paseo returns it. */
export interface WaitingEntry {
  item?: unknown;
  timestamp?: unknown;
}

/** An agent as `waitingOf` needs it: a chat peer and its workspace. */
export interface WaitingCandidate {
  id: string;
  workspaceId: string | null;
  role: string;
  title: string | null;
  status: string;
  requestId: string | null;
  archived: boolean;
  /** A fallback Worker replaced this one (delta 20260921 §4.4.8). */
  replaced?: boolean;
}

/**
 * The Workers waiting on one Manager. `entries` are that Manager's timeline,
 * NEWEST FIRST. A message counts only when another agent sent it (no
 * `clientMessageId`); the newest report of each request decides, so a later
 * `received` or `finished` hides an earlier `blocked`. A Worker is waiting
 * when that newest report is `blocked` with at least one question for its own
 * request, and the single Worker of that request is idle (or errored): a
 * running Worker already has its answer.
 *
 * `answered` is the question–answer ledger's view (design delta
 * 20260924-qa-ledger §4.1): a Worker is idle while it waits for its Reviewer
 * too, so "blocked and idle" alone showed answered questions as open again.
 * A report whose questions are ALL answered is not waiting; one with some
 * answered is still waiting, and says which in `answered`. Without it (the
 * ledger could not be read) the result is what it was before the ledger.
 */
export function waitingOf(
  manager: { id: string; workspaceId: string },
  entries: readonly WaitingEntry[],
  workers: readonly WaitingCandidate[],
  answered: (requestId: string) => ReadonlySet<string> = () => NONE_ANSWERED,
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
    // The same rule the card uses to pick where a reply goes (delta 20260918f F12).
    const worker = soleWorkerOf(
      workers.filter((candidate) => candidate.workspaceId === manager.workspaceId),
      requestId,
    );
    if (worker === null) continue;
    if (worker.status !== "idle" && worker.status !== "error") continue;
    const done = answered(requestId);
    const answeredHere = asked.questions.map((question) => question.id).filter((id) => done.has(id));
    if (answeredHere.length === asked.questions.length) continue;
    out.push({
      managerId: manager.id,
      workspaceId: manager.workspaceId,
      workerId: worker.id,
      workerTitle: worker.title,
      requestId,
      text: report.text,
      at: report.at,
      answered: answeredHere,
    });
  }
  return out;
}

/**
 * The fallback incidents the pills count: `pending`, with a `managerId` that is
 * one of `managers` (live ones: only a live chat shows a pill). Each carries
 * its Manager's workspace, where the pill goes. In the order given (the
 * incidents file keeps them oldest first).
 */
export function pendingFallbackOf(
  managers: ReadonlyArray<{ id: string; workspaceId: string }>,
  incidents: readonly FallbackIncident[],
): WaitingFallback[] {
  const workspaceOf = new Map(managers.map((manager) => [manager.id, manager.workspaceId]));
  return incidents.flatMap((incident) => {
    const workspaceId = incident.status === "pending" && incident.managerId !== null ? workspaceOf.get(incident.managerId) : undefined;
    return workspaceId === undefined ? [] : [{ managerId: incident.managerId!, workspaceId, incident }];
  });
}

export interface ChatWaitingDeps {
  homedir?: () => string;
  /** The install home; the handler looks it up (within the lookup budget), tests pass one. */
  home?: string | null;
  log?: (message: string) => void;
}

/** The install home within the lookup budget, or null. Never throws. */
async function homeOf(paseo: DashboardPaseo, deps: ChatWaitingDeps): Promise<string | null> {
  try {
    const found = deps.home !== undefined ? deps.home : await withTimeout(installHomeOf(paseo, { homedir: deps.homedir }));
    return found === null || found === TIMED_OUT ? null : found;
  } catch {
    return null;
  }
}

/** Every recorded incident; none when the install home or the file cannot be read. Never throws. */
function incidentsOf(home: string | null, deps: ChatWaitingDeps): FallbackIncident[] {
  if (home === null) return [];
  try {
    return readIncidents(home, deps.log).incidents;
  } catch {
    return [];
  }
}

/**
 * The ledger's answered questions per request, read once per call; answers
 * nothing when the install home or the ledger cannot be read, so the pills
 * fall back to what they did before the ledger. Never throws.
 */
function answeredOf(home: string | null, deps: ChatWaitingDeps): (requestId: string) => ReadonlySet<string> {
  if (home === null) return () => NONE_ANSWERED;
  const ledger = readQaLedgerSafely({ tracesDir: join(home, TRACES_DIR_NAME) });
  for (const notice of ledger.notices) (deps.log ?? ((message: string) => console.warn(message)))(`[paseo-bm] ${notice}`);
  const cache = new Map<string, ReadonlySet<string>>();
  return (requestId) => {
    let found = cache.get(requestId);
    if (found === undefined) cache.set(requestId, (found = answeredIds(ledger, requestId)));
    return found;
  };
}

/**
 * `chat.waiting` handler: every live Manager's waiting Workers and pending
 * fallback incidents. Never throws for one Manager.
 */
export async function handleChatWaiting(
  paseo: DashboardPaseo,
  deps: ChatWaitingDeps = {},
): Promise<{ waiting: WaitingWorker[]; fallback: WaitingFallback[] }> {
  const all = await bmAgentsOf(paseo);
  const managers = all.filter(
    (entry) => entry.facts.role === "manager" && !entry.facts.archived && entry.facts.status !== "closed" && entry.workspaceId !== null,
  );
  if (managers.length === 0) return { waiting: [], fallback: [] };

  // Only a live Manager's chat shows pills, so agents elsewhere are never
  // looked at and their workspace's trace store never read (delta 20260918f
  // F11). The peers come from the helper `chat.peers` uses, so a pill and its
  // card see the same Workers (F12).
  const managerWorkspaces = new Set(managers.map((manager) => manager.workspaceId!));
  const home = await homeOf(paseo, deps);
  const incidents = incidentsOf(home, deps);
  const answered = answeredOf(home, deps);
  const replacements = replacementsOf(incidents);
  const workers: WaitingCandidate[] = [];
  for (const workspaceId of managerWorkspaces) {
    for (const peer of await peersOfWorkspace(all, workspaceId, workspaceRecordsReader(paseo, workspaceId, deps), replacements)) {
      if (peer.role === "worker") workers.push({ ...peer, workspaceId });
    }
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
    waiting.push(...waitingOf({ id: manager.facts.id, workspaceId: manager.workspaceId! }, entries, workers, answered));
  }
  const fallback = pendingFallbackOf(
    managers.map((manager) => ({ id: manager.facts.id, workspaceId: manager.workspaceId! })),
    incidents,
  );
  return { waiting, fallback };
}
