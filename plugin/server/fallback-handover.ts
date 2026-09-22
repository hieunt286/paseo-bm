/**
 * The handover a replacement Worker starts from (delta 20260921 §4.4.8,
 * REQ-065 d), built in code from stored data — never summarised by a model.
 *
 * | Field | Source |
 * |---|---|
 * | `requestId` | the replaced Worker's `bm.requestId` label, recorded on the incident |
 * | report fields | the LATEST `BM-REPORT` of that request in the workspace trace store |
 * | `reviewCalls` | the request's reconstructed trace, against its tier's budget |
 * | original request | the first `user_message` of the replaced Worker's timeline |
 *
 * Each source is raced against one shared budget (5 s by default): a missing
 * part reads `unknown` (`unavailable` for the request text) and never blocks
 * the switch. The request text is masked like every trace record (REQ-048b).
 */
import { redactText } from "./collector";
import { agentFactsOf, type DashboardPaseo } from "./dashboard-rpc";
import { LIVE_MAX_PAGES, LIVE_PAGE_LIMIT, readTimelinePages, type LiveTimelinePaseo } from "./live-timeline";
import { REVIEW_BUDGET } from "./review-budget";
import { readRecords, type TraceStoreLocation } from "./trace-store";
import { reconstructTraces } from "./traces";
import { FALLBACK_CLASS_LABELS } from "../shared/bm-fallback";
import type { FallbackIncident, ParsedReport, TraceRecord } from "../shared/contracts";

/** First line of the handover. */
export const HANDOVER_MARKER = "BM-HANDOVER";

/** Budget of the whole handover (§4.4.8). */
export const HANDOVER_BUDGET_MS = 5000;

/** Longest failure message quoted in the `reason` line. */
const REASON_MESSAGE_CHARS = 300;

export interface HandoverDeps {
  /** Agent listing and timelines; `PaseoApi` is structurally assignable. */
  paseo: unknown;
  /** The workspace trace store; `null` when tracing is off (the report fields read `unknown`). */
  location: TraceStoreLocation | null;
  log?: (message: string) => void;
  budgetMs?: number;
}

/** `work()` within `budget` ms, or `null` on timeout or failure. Never throws. */
async function within<T>(budget: number, work: () => Promise<T> | T): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budget);
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The request's latest `BM-REPORT` in the trace store, or null. */
function latestReport(records: readonly TraceRecord[], requestId: string): ParsedReport | null {
  let latest: ParsedReport | null = null;
  for (const record of records) {
    for (const report of record.reports) {
      if (report.requestId !== requestId) continue;
      if (latest === null || report.at >= latest.at) latest = report;
    }
  }
  return latest;
}

/** The first `user_message` of an agent's timeline (bounded walk back to its start), masked; null when none. */
async function firstUserMessage(paseo: unknown, agentId: string): Promise<string | null> {
  let first: string | null = null;
  await readTimelinePages(paseo as LiveTimelinePaseo, agentId, { pages: LIVE_MAX_PAGES, limit: LIVE_PAGE_LIMIT }, (entries) => {
    // Pages come newest first, each oldest first: every older page's first message replaces the last one found.
    const found = entries
      .map((entry) => entry.item as { type?: unknown; text?: unknown } | undefined)
      .find((item) => item?.type === "user_message" && typeof item.text === "string" && item.text.trim() !== "");
    if (found !== undefined) first = found.text as string;
  });
  return first === null ? null : redactText(first);
}

const list = (values: readonly string[] | undefined): string => (values === undefined ? "unknown" : values.length === 0 ? "none" : values.join(", "));

/**
 * The `BM-HANDOVER` block that starts the replacement of `incident`'s Worker.
 * Never throws: every part it cannot get in time reads `unknown`.
 */
export async function workerHandover(incident: FallbackIncident, deps: HandoverDeps): Promise<string> {
  const budget = deps.budgetMs ?? HANDOVER_BUDGET_MS;
  const requestId = incident.requestId;
  const records =
    deps.location === null ? null : await within(budget, () => readRecords(deps.location!, incident.workspaceId).records);
  const [report, review, original] = await Promise.all([
    within(budget, () => (records === null || requestId === null ? null : latestReport(records, requestId))),
    within(budget, async () => {
      if (records === null || requestId === null) return null;
      const facts = await agentFactsOf(deps.paseo as DashboardPaseo, incident.workspaceId);
      return reconstructTraces({ records, agents: [...facts.values()] }).find((trace) => trace.requestId === requestId) ?? null;
    }),
    within(budget, () => firstUserMessage(deps.paseo, incident.agentId)),
  ]);

  const tier = report?.tier ?? review?.tier ?? null;
  const calls = review?.reviewCalls ?? null;
  const reviewCalls = calls === null ? "unknown" : tier === null ? `${calls} of an unknown budget` : `${calls} of ${REVIEW_BUDGET[tier]}`;
  const message = incident.message.replace(/\s+/g, " ").trim().slice(0, REASON_MESSAGE_CHARS);

  return [
    HANDOVER_MARKER,
    "role: worker",
    `requestId: ${requestId ?? "unknown"}`,
    `managerAgentId: ${incident.managerId ?? "none"}`,
    `replaces: ${incident.agentId}`,
    `reason: ${FALLBACK_CLASS_LABELS[incident.class]} — "${message}"`,
    `lastReport: ${report === null ? "none" : `${report.phase ?? "unknown"} at ${report.at}`}`,
    `tier: ${tier ?? "unknown"}`,
    `filesChanged: ${list(report?.filesChanged)}`,
    `beadsCreated: ${list(report?.beadsCreated)}`,
    `beadsUpdated: ${list(report?.beadsUpdated)}`,
    `beadsClosed: ${list(report?.beadsClosed)}`,
    `beadsReady: ${list(report?.beadsReady)}`,
    `reviewFindingsOpen: ${report === null ? "unknown" : (report.reviewFindingsOpen ?? "none")}`,
    `reviewCalls: ${reviewCalls}`,
    `skillsUsed: ${list(report?.skillsUsed)}`,
    "",
    "Original request (verbatim, the first message the replaced Worker received):",
    original ?? "unavailable",
  ].join("\n");
}
